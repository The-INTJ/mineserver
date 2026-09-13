import { Hono } from "hono";
import type { Runtime } from "../../shared/types.ts";
import { RUNTIME_PRESETS } from "../../shared/constants.ts";
import type { AppContext } from "../context.ts";
import { badRequest, conflict } from "../errors.ts";
import { writeEula } from "../fabric/eula.ts";
import { resetJavaCache } from "../fabric/java-info.ts";
import { validateRuntime } from "../profiles/profile-store.ts";
import { runtimeId } from "../runtime/runtimes.ts";
import { buildStatus, focusProfile, listRuntimes } from "../snapshot.ts";

export function setupRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/setup", async (c) => c.json((await buildStatus(ctx)).setup));

  /** Accept once; mirrored into every runtime dir on start. */
  app.post("/setup/eula", async (c) => {
    const { accepted } = await c.req.json<{ accepted?: boolean }>();
    if (accepted !== true)
      throw badRequest("EULA_NOT_ACCEPTED", "Send {accepted:true} to accept the EULA");
    await ctx.state.patch({ eulaAccepted: true });
    const focus = await focusProfile(ctx);
    if (focus) await writeEula(ctx.runtimes.paths(focus.runtime).dir, true);
    ctx.logs.note("EULA accepted");
    return c.json({ ok: true });
  });

  app.post("/setup/recheck-java", (c) => {
    resetJavaCache();
    ctx.runtimes.resetJavaCache();
    return c.json({ ok: true });
  });

  app.get("/runtimes", async (c) =>
    c.json({ runtimes: await listRuntimes(ctx), presets: RUNTIME_PRESETS }),
  );

  app.get("/runtimes/:id", async (c) => {
    const rt = await resolveRuntime(ctx, c.req.param("id"));
    return c.json(await ctx.runtimes.info(rt));
  });

  /** Install (download + run installer). Runs as a job; poll /api/jobs/:id. */
  app.post("/runtimes/install", async (c) => {
    const body = await c.req.json<{ runtime?: Runtime; profileId?: string }>();
    const rt = body.runtime
      ? validateRuntime(body.runtime)
      : (await ctx.profiles.get(body.profileId ?? "default")).runtime;
    if (ctx.jobs.running("runtime-install"))
      throw conflict("JOB_RUNNING", "A runtime install is already running");
    const job = ctx.jobs.start("runtime-install", `Install ${runtimeId(rt)}`, async (report) => {
      const info = await ctx.runtimes.install(rt, (m) => report(m));
      await ctx.runtimes.ensureEula(rt, (await ctx.state.get()).eulaAccepted);
      return info;
    });
    return c.json(job, 202);
  });

  return app;
}

async function resolveRuntime(ctx: AppContext, id: string): Promise<Runtime> {
  for (const p of await ctx.profiles.list()) if (runtimeId(p.runtime) === id) return p.runtime;
  const preset = RUNTIME_PRESETS.find((p) => runtimeId(p.runtime) === id);
  if (preset) return preset.runtime;
  throw badRequest("RUNTIME_UNKNOWN", `No profile or preset uses runtime ${id}`);
}
