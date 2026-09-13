import { Hono } from "hono";
import type { TunnelMode } from "../../shared/types.ts";
import { PLAYIT_SIZE_BYTES, PLAYIT_URL, PLAYIT_VERSION } from "../../shared/constants.ts";
import type { AppContext } from "../context.ts";
import { badRequest } from "../errors.ts";

export function tunnelRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/tunnel", async (c) =>
    c.json({
      ...(await ctx.tunnel.getState()),
      install: { version: PLAYIT_VERSION, url: PLAYIT_URL, sizeBytes: PLAYIT_SIZE_BYTES },
    }),
  );

  app.post("/tunnel/mode", async (c) => {
    const { mode, address } = await c.req.json<{ mode?: TunnelMode; address?: string }>();
    if (mode !== "off" && mode !== "playit" && mode !== "external")
      throw badRequest("BAD_MODE", "mode must be off|playit|external");
    await ctx.tunnel.setMode(mode, address);
    return c.json(await ctx.tunnel.getState());
  });

  app.post("/tunnel/install", async (c) => {
    const r = await ctx.tunnel.install();
    ctx.logs.note(`downloaded playit ${PLAYIT_VERSION} (${r.bytes} bytes)`);
    return c.json(r);
  });

  app.post("/tunnel/claim/start", async (c) => c.json(await ctx.tunnel.startClaim()));
  app.get("/tunnel/claim/status", (c) =>
    c.json(ctx.tunnel.playit.claimProgress() ?? { result: "none" }),
  );
  app.post("/tunnel/start", async (c) => c.json(await ctx.tunnel.start()));
  app.post("/tunnel/stop", async (c) => c.json(await ctx.tunnel.stop()));

  return app;
}
