import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { badRequest, conflict } from "../errors.ts";
import { modsWithState } from "../snapshot.ts";

export function modRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/mods", async (c) => {
    const profileId = c.req.query("profileId") ?? ctx.server.getState().activeProfileId;
    return c.json({ mods: await modsWithState(ctx, profileId) });
  });

  /** multipart: one or more `files` fields. */
  app.post("/mods", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const raw = body["files"] ?? body["file"];
    const files = (Array.isArray(raw) ? raw : [raw]).filter((f): f is File => f instanceof File);
    if (files.length === 0)
      throw badRequest("NO_FILES", "Upload one or more .jar files as `files`");
    const added = [];
    for (const f of files)
      added.push(await ctx.library.add(f.name, Buffer.from(await f.arrayBuffer())));
    ctx.logs.note(`added ${added.length} mod(s) to library`);
    return c.json({ added });
  });

  /** Bulk import from the local client's mods folder. */
  app.post("/mods/import-client", async (c) => {
    const r = await ctx.library.importDir(ctx.paths.minecraftMods);
    ctx.logs.note(`imported ${r.added.length} jars from ${ctx.paths.minecraftMods}`);
    return c.json(r);
  });

  app.delete("/mods/:file", async (c) => {
    const file = c.req.param("file");
    const state = ctx.server.getState();
    if (ctx.server.isActive && state.activeProfileId) {
      const p = await ctx.profiles.get(state.activeProfileId);
      if (p.enabledMods.includes(file))
        throw conflict("MOD_IN_USE", `${file} is enabled in the running profile`);
    }
    await ctx.library.remove(file);
    return c.json({ ok: true });
  });

  return app;
}
