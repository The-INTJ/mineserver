import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { badRequest, notFound } from "../errors.ts";
import { syncClientMods } from "../export/client-sync.ts";
import { exportClientZip } from "../export/client-zip.ts";
import { assertSafeSegment } from "../fsx.ts";

export function exportRoutes(ctx: AppContext) {
  const app = new Hono();

  const resolveProfileId = (id?: string) => {
    const pid = id ?? ctx.server.getState().activeProfileId;
    if (!pid) throw badRequest("NO_PROFILE", "No profile selected");
    return pid;
  };

  app.post("/export/client-zip", async (c) => {
    const body = await c.req
      .json<{ profileId?: string }>()
      .catch(() => ({}) as { profileId?: string });
    const profile = await ctx.profiles.get(resolveProfileId(body.profileId));
    const tunnel = await ctx.tunnel.getState();
    const r = await exportClientZip({
      profile,
      library: await ctx.library.list(),
      libraryDir: ctx.paths.modLibrary,
      modpacksDir: ctx.paths.modpacks,
      exportsDir: ctx.paths.exports,
      templatesDir: ctx.paths.templates,
      serverAddress: tunnel.publicAddress,
    });
    ctx.logs.note(
      `exported client zip ${r.file} (${r.includedMods.length} loose mods${r.modpackIncluded ? ", + " + r.modpackIncluded : ""})`,
    );
    return c.json(r);
  });

  app.get("/export/list", async (c) => {
    const names = (await fs.readdir(ctx.paths.exports).catch(() => [] as string[])).filter((n) =>
      n.endsWith(".zip"),
    );
    const files = [];
    for (const name of names) {
      const st = await fs.stat(path.join(ctx.paths.exports, name));
      files.push({ file: name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
    return c.json({ files: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)) });
  });

  app.get("/export/download/:file", async (c) => {
    const file = c.req.param("file");
    assertSafeSegment(file, "export file");
    const p = path.join(ctx.paths.exports, file);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) throw notFound("EXPORT_NOT_FOUND", `No export ${file}`);
    c.header("Content-Type", "application/zip");
    c.header("Content-Length", String(st.size));
    c.header("Content-Disposition", `attachment; filename="${file}"`);
    return c.body(Readable.toWeb(createReadStream(p)) as ReadableStream);
  });

  app.post("/export/sync-client", async (c) => {
    const body = await c.req
      .json<{ profileId?: string }>()
      .catch(() => ({}) as { profileId?: string });
    const profile = await ctx.profiles.get(resolveProfileId(body.profileId));
    if (profile.modpack) {
      throw badRequest(
        "SYNC_MODPACK",
        "This profile is a modpack: install it in your launcher from the export zip instead of syncing .minecraft/mods",
      );
    }
    const r = await syncClientMods({
      profile,
      library: await ctx.library.list(),
      libraryDir: ctx.paths.modLibrary,
      clientModsDir: ctx.paths.minecraftMods,
      manifestFile: ctx.paths.clientSyncManifest,
    });
    ctx.logs.note(`synced ${r.copied.length} mods to ${r.targetDir} (removed ${r.removed.length})`);
    return c.json(r);
  });

  return app;
}
