import { Hono } from "hono";
import type { Profile, ProfileInput } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest, conflict } from "../errors.ts";

export function profileRoutes(ctx: AppContext) {
  const app = new Hono();

  const guardActiveRunning = (id: string) => {
    if (ctx.server.isActive && ctx.server.getState().activeProfileId === id) {
      throw conflict("PROFILE_RUNNING", "Stop the server before changing the running profile");
    }
  };

  app.get("/profiles", async (c) =>
    c.json({
      profiles: await ctx.profiles.list(),
      activeProfileId: ctx.server.getState().activeProfileId,
    }),
  );

  app.post("/profiles", async (c) => {
    const input = await c.req.json<ProfileInput>();
    return c.json(await ctx.profiles.create(input), 201);
  });

  app.get("/profiles/:id", async (c) => c.json(await ctx.profiles.get(c.req.param("id"))));

  app.put("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    guardActiveRunning(id);
    const patch = await c.req.json<Partial<Profile>>();
    delete patch.id;
    delete patch.createdAt;
    if (patch.jvm && (!Number.isFinite(patch.jvm.maxMemoryGb) || patch.jvm.maxMemoryGb < 1)) {
      throw badRequest("BAD_JVM", "jvm.maxMemoryGb must be >= 1");
    }
    const updated = await ctx.profiles.update(id, patch);
    if (ctx.server.getState().activeProfileId === id) ctx.server.setActiveProfile(updated);
    return c.json(updated);
  });

  app.delete("/profiles/:id", async (c) => {
    const id = c.req.param("id");
    guardActiveRunning(id);
    if (id === "default")
      throw badRequest("PROFILE_PROTECTED", "The default profile cannot be deleted");
    await ctx.profiles.remove(id);
    if (ctx.server.getState().activeProfileId === id) {
      await ctx.state.patch({ activeProfileId: null });
      ctx.server.setActiveProfile(null);
    }
    return c.json({ ok: true });
  });

  /** Make this the profile the next Start uses. Refused while the server is up. */
  app.post("/profiles/:id/activate", async (c) => {
    const id = c.req.param("id");
    if (ctx.server.isActive)
      throw conflict("SERVER_RUNNING", "Stop the server before switching profiles");
    const profile = await ctx.profiles.get(id);
    await ctx.state.patch({ activeProfileId: id });
    ctx.server.setActiveProfile(profile);
    return c.json({ ok: true, activeProfileId: id });
  });

  /** Toggle a library jar in this profile. side=server (loaded by the server) or client (export-only). */
  app.post("/profiles/:id/mods", async (c) => {
    const id = c.req.param("id");
    const { file, enabled, side } = await c.req.json<{
      file?: string;
      enabled?: boolean;
      side?: "server" | "client";
    }>();
    if (!file || typeof enabled !== "boolean")
      throw badRequest("BAD_TOGGLE", "Send {file, enabled, side?}");
    await ctx.library.get(file);
    // Toggling while running is allowed (it only affects the next launch); make that visible.
    if (ctx.server.isActive && ctx.server.getState().activeProfileId === id) {
      ctx.logs.note(
        `mod ${file} ${enabled ? "enabled" : "disabled"} for ${id}; takes effect on next start`,
      );
    }
    return c.json(
      await ctx.profiles.setModEnabled(id, file, enabled, side === "client" ? "client" : "server"),
    );
  });

  return app;
}
