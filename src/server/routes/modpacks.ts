import { promises as fs } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { ModpackImportResult } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { badRequest, conflict } from "../errors.ts";
import { assertSafeSegment, slugify } from "../fsx.ts";
import {
  applyOverrides,
  downloadMrpack,
  downloadMrpackFiles,
  modpackRef,
  planMrpack,
  readMrpackIndex,
  resolveModpackSource,
} from "../mods/mrpack.ts";
import { runtimeId } from "../runtime/runtimes.ts";

/**
 * Modpack import: resolve source → download .mrpack → plan → install runtime if needed →
 * download server-side jars into the library → apply overrides → create a profile. One job.
 */
export function modpackRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get("/modpacks", async (c) => {
    const names = (await fs.readdir(ctx.paths.modpacks).catch(() => [] as string[])).filter((n) =>
      n.endsWith(".mrpack"),
    );
    const files = [];
    for (const name of names) {
      const st = await fs.stat(path.join(ctx.paths.modpacks, name));
      files.push({ file: name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
    }
    return c.json({ files });
  });

  /** body: { source: "<modrinth url|slug|.mrpack url>", profileName?, world?, maxMemoryGb? } or multipart `file`. */
  app.post("/modpacks/import", async (c) => {
    let source: string | null = null;
    let uploaded: { name: string; data: Buffer } | null = null;
    let profileName: string | undefined;
    let world: string | undefined;
    let maxMemoryGb: number | undefined;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const f = body["file"];
      if (f instanceof File) uploaded = { name: f.name, data: Buffer.from(await f.arrayBuffer()) };
      if (typeof body["profileName"] === "string") profileName = body["profileName"];
      if (typeof body["world"] === "string") world = body["world"];
      if (typeof body["maxMemoryGb"] === "string") maxMemoryGb = Number(body["maxMemoryGb"]);
    } else {
      const body = await c.req.json<{
        source?: string;
        profileName?: string;
        world?: string;
        maxMemoryGb?: number;
      }>();
      source = body.source ?? null;
      profileName = body.profileName;
      world = body.world;
      maxMemoryGb = body.maxMemoryGb;
    }
    if (!source && !uploaded)
      throw badRequest(
        "SOURCE_REQUIRED",
        "Send {source} (Modrinth URL/slug or .mrpack URL) or upload a .mrpack as `file`",
      );
    if (ctx.jobs.running("modpack-import"))
      throw conflict("JOB_RUNNING", "A modpack import is already running");

    const job = ctx.jobs.start(
      "modpack-import",
      `Import modpack ${uploaded?.name ?? source}`,
      async (report): Promise<ModpackImportResult> => {
        // 1. Get the .mrpack.
        let mrpackFile: string;
        let packName: string;
        let packVersion: string;
        let packSource: string;
        if (uploaded) {
          assertSafeSegment(uploaded.name, "mrpack filename");
          mrpackFile = uploaded.name.endsWith(".mrpack")
            ? uploaded.name
            : `${uploaded.name}.mrpack`;
          await fs.mkdir(ctx.paths.modpacks, { recursive: true });
          await fs.writeFile(path.join(ctx.paths.modpacks, mrpackFile), uploaded.data);
          packName = mrpackFile.replace(/\.mrpack$/, "");
          packVersion = "?";
          packSource = `upload:${uploaded.name}`;
        } else {
          report(`resolving ${source}`);
          const r = await resolveModpackSource(source!);
          mrpackFile = r.filename;
          packName = r.name;
          packVersion = r.version;
          packSource = r.url;
          report(`downloading ${r.filename}`);
          await downloadMrpack(r.url, path.join(ctx.paths.modpacks, mrpackFile), (mb) =>
            report(`downloading ${r.filename}: ${mb.toFixed(0)} MB`),
          );
        }
        const mrpackPath = path.join(ctx.paths.modpacks, mrpackFile);

        // 2. Plan.
        const index = await readMrpackIndex(mrpackPath);
        const plan = planMrpack(index);
        if (packVersion === "?") packVersion = index.versionId;
        if (packName === mrpackFile.replace(/\.mrpack$/, "")) packName = index.name;
        const rt = plan.runtime;
        ctx.logs.note(
          `modpack "${index.name}" ${index.versionId}: ${plan.serverFiles.length} server jars, ${plan.clientFiles.length} client-only, runtime ${runtimeId(rt)}`,
        );

        // 3. Runtime.
        if (!(await ctx.runtimes.installed(rt))) {
          report(`installing runtime ${runtimeId(rt)}`);
          await ctx.runtimes.install(rt, (m) => report(`[${runtimeId(rt)}] ${m}`));
        }
        await ctx.runtimes.ensureEula(rt, (await ctx.state.get()).eulaAccepted);

        // 4. Jars → library (server + client-only, so exports and the UI can see both).
        const all = [...plan.serverFiles, ...plan.clientFiles];
        const serverNames = new Set(
          plan.serverFiles.map((f) => path.basename(f.path.replace(/\\/g, "/"))),
        );
        await downloadMrpackFiles(all, ctx.library, (done, total, cur) =>
          report(`mods ${done}/${total}: ${cur}`, 0.2 + 0.7 * (done / total)),
        );

        // 5. Overrides into the runtime dir; override jars into the library as server mods.
        report("applying overrides");
        const rp = ctx.runtimes.paths(rt);
        const ov = await applyOverrides(mrpackPath, rp.dir);
        for (const j of ov.overrideJars) {
          await ctx.library.add(j.name, j.data, { refresh: false });
          serverNames.add(j.name);
        }
        await ctx.library.refresh();
        ctx.logs.note(
          `modpack overrides: ${ov.files} files into ${rp.dir}, ${ov.overrideJars.length} override jars`,
        );

        // 6. Profile.
        const name = profileName?.trim() || index.name;
        const profile = await ctx.profiles.create({
          name,
          runtime: rt,
          world: world?.trim() ? slugify(world) : slugify(name),
          enabledMods: [...serverNames].sort(),
          clientMods: plan.clientFiles.map((f) => path.basename(f.path.replace(/\\/g, "/"))).sort(),
          jvm: {
            maxMemoryGb: maxMemoryGb && maxMemoryGb >= 1 ? Math.round(maxMemoryGb) : 6,
            extraArgs: [],
          },
          properties: { motd: `${index.name} ${index.versionId}` },
          modpack: modpackRef(packName, packVersion, packSource, mrpackFile),
        });
        report("done", 1);
        return {
          profileId: profile.id,
          runtime: await ctx.runtimes.info(rt),
          serverMods: profile.enabledMods,
          clientMods: profile.clientMods,
          skippedNonMods: plan.nonMods,
          overrideFiles: ov.files,
          modpack: profile.modpack!,
        };
      },
    );
    return c.json(job, 202);
  });

  return app;
}
