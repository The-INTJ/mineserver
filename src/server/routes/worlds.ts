import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { badRequest, conflict } from "../errors.ts";

export function worldRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/worlds", async (c) =>
    c.json({ worlds: await ctx.worlds.list(), activeWorld: await ctx.worlds.activeWorld() }),
  );

  app.get("/worlds/import/candidates", async (c) =>
    c.json({ candidates: await ctx.worlds.importCandidates(), savesDir: ctx.paths.minecraftSaves }),
  );

  app.post("/worlds/import", async (c) => {
    const { sourceName, targetName } = await c.req.json<{
      sourceName?: string;
      targetName?: string;
    }>();
    if (!sourceName) throw badRequest("SOURCE_REQUIRED", "sourceName is required");
    const world = await ctx.worlds.importFromSaves(sourceName, targetName);
    ctx.logs.note(`imported world "${sourceName}" as ${world.name}`);
    return c.json(world, 201);
  });

  app.delete("/worlds/:name", async (c) => {
    const name = c.req.param("name");
    if (ctx.server.isActive)
      throw conflict("SERVER_RUNNING", "Stop the server before deleting worlds");
    await ctx.worlds.remove(name);
    return c.json({ ok: true });
  });

  return app;
}
