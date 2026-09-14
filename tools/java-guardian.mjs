// Plain Node works with both tsx development and compiled production. Owns Java independently
// of the UI process: a lost parent requests stop and allows time for Minecraft to save.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [runtimeDir, receiptFile] = process.argv.slice(2);
const key = createHash("sha256").update(path.resolve(runtimeDir).toLowerCase()).digest("hex");
const lock = createServer((socket) => socket.end());
const address =
  process.platform === "win32"
    ? `\\\\.\\pipe\\mineserver-java-${key}`
    : { host: "127.0.0.1", port: 40000 + (parseInt(key.slice(0, 6), 16) % 9000) };
let java;
let timer;
let stopTimeoutMs = 60000;
let emergencyBytes = 0;
let finished = false;
let pendingBytes = 0;
let droppedLines = 0;
let receipt = {
  guardianPid: process.pid,
  pid: null,
  endedAt: null,
  code: null,
  signal: null,
  reason: null,
  saveConfirmedAt: null,
  forced: false,
};
const send = (message) => {
  if (!process.connected) return;
  const size = message.type === "line" ? Buffer.byteLength(message.text) + 128 : 0;
  if (size && pendingBytes + size > 1024 * 1024) {
    droppedLines++;
    return;
  }
  pendingBytes += size;
  process.send(message, () => {
    pendingBytes -= size;
    if (droppedLines && pendingBytes < 512 * 1024 && process.connected) {
      const count = droppedLines;
      droppedLines = 0;
      send({
        type: "warning",
        text: `Guardian omitted ${count} log lines because the manager was slow; consult Minecraft logs`,
      });
    }
  });
};
function persist() {
  try {
    mkdirSync(path.dirname(receiptFile), { recursive: true });
    writeFileSync(`${receiptFile}.tmp`, JSON.stringify(receipt));
    renameSync(`${receiptFile}.tmp`, receiptFile);
  } catch (error) {
    send({ type: "warning", text: `Guardian receipt unavailable: ${error.message}` });
  }
}
function finish(code, signal) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  receipt = { ...receipt, endedAt: new Date().toISOString(), code, signal };
  persist();
  const closed = () => {
    send({ type: "closed", code, signal, receipt });
    if (process.connected) process.disconnect();
  };
  // Report completion only after releasing ownership, so an immediate Restart can acquire it.
  if (lock.listening) lock.close(closed);
  else closed();
}
function force() {
  if (!java || finished) return;
  receipt.forced = true;
  persist();
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(java.pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (err) send({ type: "warning", text: `Force stop failed: ${err.message}` });
    });
  } else java.kill("SIGKILL");
}
function stop(reason) {
  if (!java) {
    finish(null, null);
    return;
  }
  if (receipt.reason || finished) return;
  receipt.reason = reason;
  persist();
  java.stdin.write("stop\n", () => {});
  timer = setTimeout(force, stopTimeoutMs);
}
lock.on("error", (error) => {
  send({ type: "error", text: `Runtime already owned or lock unavailable: ${error.message}` });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
lock.listen(address, () => send({ type: "prepared" }));
process.on("disconnect", () => stop("manager connection lost; graceful save requested"));
process.on("SIGTERM", () => stop("guardian SIGTERM"));
process.on("SIGINT", () => stop("guardian SIGINT"));
process.on("message", (message) => {
  if (message.type === "stop") return stop(message.reason ?? "requested stop");
  if (message.type === "force") return force();
  if (message.type === "command") {
    if (java && !finished && !receipt.reason) java.stdin.write(`${message.line}\n`, () => {});
    return;
  }
  if (message.type !== "launch" || java || finished) return;
  stopTimeoutMs = message.stopTimeoutMs ?? 60000;
  java = spawn(message.javaPath, message.args, {
    cwd: runtimeDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  java.stdin.on("error", (error) =>
    send({ type: "warning", text: `Java stdin: ${error.message}` }),
  );
  for (const [name, stream] of [
    ["stdout", java.stdout],
    ["stderr", java.stderr],
  ]) {
    readline.createInterface({ input: stream, crlfDelay: Infinity }).on("line", (text) => {
      if (
        /\[Server thread\/INFO\](?: \[[^\]]+\])?: (?:ThreadedAnvilChunkStorage: All dimensions are saved|Saved the game)\s*$/.test(
          text,
        )
      ) {
        receipt.saveConfirmedAt = new Date().toISOString();
        persist();
      }
      if (process.connected) send({ type: "line", stream: name, text: text.slice(0, 32768) });
      else if (emergencyBytes < 1024 * 1024) {
        try {
          const line = `${new Date().toISOString()} [${name}] ${text.slice(0, 32768)}\n`;
          appendFileSync(`${receiptFile}.log`, line);
          emergencyBytes += Buffer.byteLength(line);
        } catch {
          /* Independent receipt and normal game logs remain available. */
        }
      }
    });
  }
  java.once("spawn", () => {
    receipt.pid = java.pid;
    persist();
    send({ type: "started", pid: java.pid });
  });
  java.once("error", (error) => {
    receipt.reason = `spawn error: ${error.message}`;
    send({ type: "error", text: receipt.reason });
  });
  java.once("close", finish);
});
