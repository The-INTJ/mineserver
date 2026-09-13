import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { ApiError } from "../shared/types.ts";
import type { AppContext } from "./context.ts";
import { AppError } from "./errors.ts";
import { debugRoutes } from "./routes/debug.ts";
import { exportRoutes } from "./routes/export.ts";
import { logRoutes } from "./routes/logs.ts";
import { modRoutes } from "./routes/mods.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { serverRoutes } from "./routes/server.ts";
import { setupRoutes } from "./routes/setup.ts";
import { tunnelRoutes } from "./routes/tunnel.ts";
import { worldRoutes } from "./routes/worlds.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createApp(ctx: AppContext) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code } satisfies ApiError, err.status as 400);
    }
    console.error(err);
    return c.json({ error: err.message, code: "INTERNAL" } satisfies ApiError, 500);
  });

  const api = new Hono();
  for (const r of [
    serverRoutes,
    logRoutes,
    setupRoutes,
    modRoutes,
    profileRoutes,
    worldRoutes,
    exportRoutes,
    tunnelRoutes,
    debugRoutes,
  ]) {
    api.route("/", r(ctx));
  }
  api.notFound((c) =>
    c.json({ error: "no such endpoint", code: "NOT_FOUND" } satisfies ApiError, 404),
  );
  app.route("/api", api);

  // Static UI from dist/ui (built by `vite build`). Hand-rolled so it's cwd-independent.
  const uiDir = path.join(ctx.paths.root, "dist", "ui");
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidate = path.normalize(path.join(uiDir, rel));
    if (rel && candidate.startsWith(uiDir + path.sep)) {
      const data = await fs.readFile(candidate).catch(() => null);
      if (data) {
        c.header("Content-Type", MIME[path.extname(candidate)] ?? "application/octet-stream");
        if (rel.startsWith("assets/"))
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        return c.body(data);
      }
    }
    const index = await fs.readFile(path.join(uiDir, "index.html"), "utf8").catch(() => null);
    if (!index) {
      return c.text(
        "mineserver daemon is running. UI not built: run `npm run build` (or use `npm run dev` on :3401).",
        200,
      );
    }
    return c.html(index);
  });

  return app;
}
