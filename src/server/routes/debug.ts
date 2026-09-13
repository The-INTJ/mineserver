import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { buildSnapshot } from "../snapshot.ts";

export function debugRoutes(ctx: AppContext) {
  const app = new Hono();
  app.get("/debug/snapshot", async (c) => c.json(await buildSnapshot(ctx)));
  app.get("/debug/paths", (c) => c.json(ctx.paths));
  return app;
}
