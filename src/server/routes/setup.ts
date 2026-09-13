import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { badRequest } from "../errors.ts";
import { writeEula } from "../fabric/eula.ts";
import { downloadLauncher } from "../fabric/fabric-launcher.ts";
import { resetJavaCache } from "../fabric/java-info.ts";
import { buildStatus } from "../snapshot.ts";

export function setupRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/setup", async (c) => c.json((await buildStatus(ctx)).setup));

  app.post("/setup/eula", async (c) => {
    const { accepted } = await c.req.json<{ accepted?: boolean }>();
    if (accepted !== true)
      throw badRequest("EULA_NOT_ACCEPTED", "Send {accepted:true} to accept the EULA");
    await writeEula(ctx.paths.server, true);
    await ctx.state.patch({ eulaAccepted: true });
    ctx.logs.note("EULA accepted");
    return c.json({ ok: true });
  });

  app.post("/setup/download-launcher", async (c) => {
    const r = await downloadLauncher(ctx.paths.server);
    ctx.logs.note(`downloaded Fabric launcher (${r.bytes} bytes)`);
    return c.json(r);
  });

  app.post("/setup/recheck-java", (c) => {
    resetJavaCache();
    return c.json({ ok: true });
  });

  return app;
}
