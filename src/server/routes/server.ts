import path from "node:path";
import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { badRequest } from "../errors.ts";
import { buildStatus } from "../snapshot.ts";

export function serverRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/server/incidents", async (c) =>
    c.json({ incidents: await ctx.server.incidents.list() }),
  );
  app.post("/server/save", async (c) => c.json(await ctx.server.save()));
  app.post("/server/backup", async (c) => {
    const entry = await ctx.worldBackups.backup();
    return c.json({
      file: path.basename(entry.backupLocation),
      sha1: entry.sha1,
      size: entry.size,
    });
  });
  app.post("/manager/shutdown", (c) => {
    if (!ctx.shutdown) return c.json({ error: "Shutdown unavailable", code: "UNAVAILABLE" }, 409);
    setTimeout(() => ctx.shutdown?.(), 100);
    return c.json({ ok: true });
  });
  app.get("/status", async (c) => c.json(await buildStatus(ctx)));

  app.post("/server/start", async (c) => {
    const body = await c.req
      .json<{ profileId?: string }>()
      .catch(() => ({}) as { profileId?: string });
    return c.json(await ctx.server.start(body.profileId));
  });

  app.post("/server/stop", async (c) => c.json(await ctx.server.stop()));
  app.post("/server/restart", async (c) => c.json(await ctx.server.restart()));

  app.post("/server/command", async (c) => {
    const { command } = await c.req.json<{ command?: string }>();
    if (!command?.trim()) throw badRequest("COMMAND_REQUIRED", "command is required");
    ctx.server.send(command.trim().replace(/^\//, ""));
    return c.json({ ok: true });
  });

  app.get("/server/players", (c) => c.json({ players: ctx.server.getState().players }));

  app.post("/server/whitelist", async (c) => {
    const { name } = await c.req.json<{ name?: string }>();
    if (!name || !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
      throw badRequest(
        "BAD_USERNAME",
        "Minecraft usernames are 3-16 letters, digits or underscores",
      );
    }
    ctx.server.send(`whitelist add ${name}`);
    return c.json({ ok: true });
  });

  return app;
}
