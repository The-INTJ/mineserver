import type { LogKind, LogLevel } from "../../shared/types.ts";

export interface Classified {
  level: LogLevel;
  kind: LogKind;
  player?: string;
  /** Message with the `[time] [thread/LEVEL]:` prefix stripped. */
  message: string;
}

// Vanilla:  [12:34:56] [Server thread/INFO]: Done (3.456s)! For help, type "help"
// Fabric:   [12:34:56] [Server thread/INFO] (Minecraft) Done (3.456s)! ...  (logger in parens, no colon)
// Forge:    [12:34:56] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: Done (18.390s)! ...
//           (logger in a second bracket pair; missing this one kept a healthy Forge server in
//           "starting" until the quiet watchdog killed it — verified 2026-09-13)
const PREFIX =
  /^\[\d\d:\d\d:\d\d\] \[[^\]]*\/(INFO|WARN|ERROR|FATAL|DEBUG)\](?: \[[^\]]*\])?:? (?:\([^)]*\) )?(.*)$/;

const DONE = /^Done \([\d.,]+s\)!/;
const JOIN = /^(\S+) joined the game$/;
const LEFT = /^(\S+) left the game$/;
const LOST = /^(\S+) lost connection: /;
const CHAT = /^<(\S+)> /;
const EULA = /agree to the EULA/i;
const CRASH =
  /(Encountered an unexpected exception|Crash report saved to|#@!@# Game crashed|This crash report has been saved to|Failed to start the minecraft server|Error during pre-loading phase)/;

export function classify(raw: string): Classified {
  const m = PREFIX.exec(raw);
  const level: LogLevel = m ? (m[1] as LogLevel) : "RAW";
  const message = m ? m[2] : raw;

  if (DONE.test(message)) return { level, kind: "done", message };
  if (EULA.test(message)) return { level, kind: "eula", message };
  if (CRASH.test(message) || level === "FATAL") return { level, kind: "crash", message };
  let p = JOIN.exec(message);
  if (p) return { level, kind: "join", player: p[1], message };
  p = LEFT.exec(message) ?? LOST.exec(message);
  if (p) return { level, kind: "leave", player: p[1], message };
  p = CHAT.exec(message);
  if (p) return { level, kind: "chat", player: p[1], message };
  return { level, kind: "other", message };
}
