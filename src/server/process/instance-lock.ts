import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import path from "node:path";

/** OS-owned lock: automatically released on process death, with no stale PID killing. */
export async function acquireInstanceLock(dataDir: string): Promise<Server> {
  const key = createHash("sha256").update(path.resolve(dataDir).toLowerCase()).digest("hex");
  const server = createServer((socket) => socket.end());
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mineserver-manager-${key}`
      : { host: "127.0.0.1", port: 50000 + (parseInt(key.slice(0, 6), 16) % 9000) };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (err) => console.error("Instance lock:", err));
  return server;
}
