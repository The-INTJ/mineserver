import { createReadStream, promises as fs } from "node:fs";
import { createGunzip } from "node:zlib";
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
    const raw = Number(c.req.query("lines") ?? 200);
    const lines = Number.isFinite(raw) ? Math.min(2000, Math.max(1, Math.floor(raw))) : 200;
    const query = c.req.query("grep");
    if (query && query.length > 256)
      throw badRequest("BAD_FILTER", "Filter is limited to 256 characters");
    // Literal alternatives avoid running user-supplied backtracking regex on the event loop.
    const grep = query
      ? new RegExp(
          query
            .split("|")
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "i",
        )
      : undefined;
    return c.json({
      lines: ctx.logs.tail(lines, grep),
      lastSeq: ctx.logs.lastSeq,
      sessionId: ctx.logs.sessionId,
    });
  });
  app.get("/logs/stream", (c) =>
    streamSSE(c, async (stream) => {
      type Event = { event: string; data: string; id?: string };
      const since =
        c.req.query("session") === ctx.logs.sessionId ? Number(c.req.query("since") ?? 0) : 0;
      const queue: Event[] = [
        { event: "session", data: JSON.stringify(ctx.logs.sessionId) },
        ...ctx.logs
          .since(Number.isFinite(since) ? since : 0)
          .slice(-400)
          .map((line) => ({ event: "log", data: JSON.stringify(line), id: String(line.seq) })),
        { event: "state", data: JSON.stringify(ctx.server.getState()) },
      ];
      let wake: (() => void) | null = null;
      const enqueue = (event: Event) => {
        if (queue.length >= 500) {
          stream.abort();
          wake?.();
          return;
        }
        queue.push(event);
        wake?.();
      };
      const onLine = (line: LogLine) =>
        enqueue({ event: "log", data: JSON.stringify(line), id: String(line.seq) });
      const onState = (state: ServerState) =>
        enqueue({ event: "state", data: JSON.stringify(state) });
      stream.onAbort(() => wake?.());
      ctx.logs.on("line", onLine);
      ctx.server.on("state", onState);
      const keepalive = setInterval(() => enqueue({ event: "keepalive", data: "null" }), 15000);
      try {
        while (!stream.aborted) {
          const event = queue.shift();
          if (event) {
            let timeout: NodeJS.Timeout | undefined;
            await Promise.race([
              stream.writeSSE(event),
              new Promise<void>((resolve) => {
                timeout = setTimeout(() => {
                  stream.abort();
                  resolve();
                }, 10000);
              }),
            ]);
            clearTimeout(timeout);
          } else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          wake = null;
        }
      } finally {
        clearInterval(keepalive);
        ctx.logs.off("line", onLine);
        ctx.server.off("state", onState);
      }
    }),
  );
  app.get("/logs/files", async (c) => c.json({ files: await listLogFiles(ctx) }));
  app.get("/logs/files/:source/:name", async (c) => {
    const source = c.req.param("source");
    const name = c.req.param("name");
    if (source !== "daemon" && source !== "server" && source !== "crash")
      throw notFound("BAD_SOURCE", "unknown source");
    assertSafeSegment(name, "log file name");
    const dir = await logFileDir(ctx, source);
    if (!dir || !/\.(log|log\.gz|txt)$/.test(name)) throw notFound("LOG_NOT_FOUND", "No such log");
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw notFound("LOG_NOT_FOUND", "No such log");
    const raw = Number(c.req.query("maxChars") ?? 128000);
    const limit = Number.isFinite(raw) ? Math.max(1000, Math.min(2000000, raw)) : 128000;
    let text = "";
    let bytes = 0;
    let truncated = false;
    const input = createReadStream(file);
    const output = name.endsWith(".gz") ? input.pipe(createGunzip()) : input;
    input.on("error", (err) => output.destroy(err));
    try {
      for await (const chunk of output) {
        bytes += chunk.length;
        text += chunk.toString("utf8");
        if (text.length > limit) {
          truncated = true;
          text = text.slice(-limit);
        }
        if (bytes > 64 * 1024 * 1024) {
          truncated = true;
          break;
        }
      }
    } finally {
      input.destroy();
      output.destroy();
    }
    return c.text((truncated ? "[truncated log; bounded read]\n" : "") + text);
  });
  return app;
}
