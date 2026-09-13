import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { badRequest } from "../errors.ts";
import { listRuntimes } from "../snapshot.ts";
import { lookupUuid, mergeWhitelist, readWhitelist, type WhitelistEntry } from "../whitelist.ts";

/**
 * Whitelist across ALL runtimes at once, so switching Fabric ↔ Forge doesn't lose anyone.
 * Writes whitelist.json in every runtime dir; if a server is running it also gets
 * `whitelist reload` so the file takes effect immediately.
 */
export function whitelistRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/whitelist", async (c) => {
    const out: Record<string, WhitelistEntry[]> = {};
    for (const rt of await listRuntimes(ctx)) out[rt.id] = await readWhitelist(rt.dir);
    return c.json({ byRuntime: out });
  });

  /** body: { names: string[] } */
  app.post("/whitelist", async (c) => {
    const { names } = await c.req.json<{ names?: string[] }>();
    if (!Array.isArray(names) || names.length === 0)
      throw badRequest("NAMES_REQUIRED", "Send {names: [...]}");
    const resolved: WhitelistEntry[] = [];
    const unknown: string[] = [];
    for (const n of names) {
      const e = await lookupUuid(n.trim());
      if (e) resolved.push(e);
      else unknown.push(n);
    }
    const applied: Record<string, WhitelistEntry[]> = {};
    for (const rt of await listRuntimes(ctx))
      applied[rt.id] = await mergeWhitelist(rt.dir, resolved);
    if (ctx.server.getState().status === "running") ctx.server.send("whitelist reload");
    ctx.logs.note(
      `whitelist: added ${resolved.map((e) => e.name).join(", ") || "nobody"}${unknown.length ? `; unknown accounts: ${unknown.join(", ")}` : ""}`,
    );
    return c.json({ added: resolved, unknown, byRuntime: applied });
  });

  return app;
}
