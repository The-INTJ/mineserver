import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { LogLine, ServerState } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../errors.ts";
import { assertSafeSegment } from "../fsx.ts";
import { listLogFiles, logFileDir } from "../snapshot.ts";

export function logRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/logs", (c) => {
    const lines = Math.min(2000, Math.max(1, Number(c.req.query("lines") ?? 200)));
    const grepRaw = c.req.query("grep");
    let grep: RegExp | undefined;
    if (grepRaw) {
      try {
        grep = new RegExp(grepRaw, "i");
      } catch {
        throw badRequest("BAD_REGEX", `Invalid grep pattern: ${grepRaw}`);
      }
    }
    return c.json({ lines: ctx.logs.tail(lines, grep), lastSeq: ctx.logs.lastSeq });
  });

  /**
   * SSE: replays everything after ?since=<seq>, then streams. Events:
   *   log   { LogLine }      state { ServerState }      (plus ": keepalive" comments)
   */
  app.get("/logs/stream", (c) =>
    streamSSE(c, async (stream) => {
      const since = Number(c.req.query("since") ?? 0);
      for (const line of ctx.logs.since(since)) {
        await stream.writeSSE({ event: "log", data: JSON.stringify(line), id: String(line.seq) });
      }
      await stream.writeSSE({ event: "state", data: JSON.stringify(ctx.server.getState()) });

      const onLine = (line: LogLine) =>
        void stream.writeSSE({ event: "log", data: JSON.stringify(line), id: String(line.seq) });
      const onState = (state: ServerState) =>
        void stream.writeSSE({ event: "state", data: JSON.stringify(state) });
      ctx.logs.on("line", onLine);
      ctx.server.on("state", onState);
      const keepalive = setInterval(() => void stream.write(": keepalive\n\n"), 15_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(keepalive);
      ctx.logs.off("line", onLine);
      ctx.server.off("state", onState);
    }),
  );

  app.get("/logs/files", async (c) => c.json({ files: await listLogFiles(ctx) }));

  app.get("/logs/files/:source/:name", async (c) => {
    const source = c.req.param("source");
    const name = c.req.param("name");
    if (source !== "daemon" && source !== "server" && source !== "crash")
      throw notFound("BAD_SOURCE", "unknown source");
    assertSafeSegment(name, "log file name");
    const file = path.join(logFileDir(ctx, source), name);
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === null) throw notFound("LOG_NOT_FOUND", `No ${source} log ${name}`);
    return c.text(text);
  });

  return app;
}
