import { serve } from "@hono/node-server";
import readline from "node:readline";
import { isatty } from "node:tty";
import { DAEMON_PORT } from "../shared/constants.ts";
import { createApp } from "./app.ts";
import { createContext } from "./context.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  // Localhost only unless explicitly asked. The UI can start/stop processes and read every log;
  // it is Drew's alone. Only the game port ever goes through the tunnel.
  const host = arg("host") ?? process.env.MINESERVER_HOST ?? "127.0.0.1";
  const port = Number(arg("port") ?? process.env.MINESERVER_PORT ?? DAEMON_PORT);
  const ctx = await createContext({ dataDir: arg("data") });
  const app = createApp(ctx);

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`mineserver daemon listening on http://${info.address}:${info.port}`);
    console.log(`data dir: ${ctx.paths.data}`);
    console.log(`java: ${ctx.javaPath}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use. Is another mineserver daemon running?`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  // Never orphan the Java child: if the daemon dies, the server goes with it (and the tunnel).
  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${why}: stopping server...`);
    const t = setTimeout(() => {
      ctx.server.killSync();
      ctx.tunnel.killSync();
      process.exit(0);
    }, 70_000);
    await ctx.server.stop().catch(() => undefined);
    await ctx.tunnel.stop().catch(() => undefined);
    clearTimeout(t);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", () => {
    ctx.server.killSync();
    ctx.tunnel.killSync();
  });
  // Ctrl+C in a Windows console doesn't reliably raise SIGINT; readline does. Check the fd with
  // isatty() rather than `process.stdin.isTTY`: merely *creating* process.stdin blocks forever on
  // Windows when stdin is a pipe with no writer (how the app's preview runner spawns us).
  if (process.platform === "win32" && isatty(0)) {
    readline
      .createInterface({ input: process.stdin, output: process.stdout })
      .on("SIGINT", () => process.emit("SIGINT"));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
