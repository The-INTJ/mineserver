// Compare a CurseForge modpack manifest against mineserver's library; download what's missing
// from the CurseForge CDN (no API key: the public files/<id>/download redirect) and enable it in a
// profile on both sides. Usage: node cf-sync.mjs <manifest.json> <profileId>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const [manifestPath, profileId] = process.argv.slice(2);
const B = "http://127.0.0.1:3400/api";
const UA = { "user-agent": "Mozilla/5.0 mineserver/0.1 (drew@taylorspot.com)" };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const lib = (await (await fetch(`${B}/mods`)).json()).mods;
const have = new Set(lib.map((m) => m.file));
const haveIds = new Set(lib.map((m) => m.id));

const resolve = async (f) => {
  const url = `https://www.curseforge.com/api/v1/mods/${f.projectID}/files/${f.fileID}/download`;
  const r = await fetch(url, { method: "HEAD", redirect: "manual", headers: UA });
  const loc = r.headers.get("location");
  if (!loc) return { ...f, error: `HTTP ${r.status}` };
  return { ...f, url: loc, filename: decodeURIComponent(basename(new URL(loc).pathname)) };
};

const results = [];
const queue = [...manifest.files];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      try {
        results.push(await resolve(f));
      } catch (e) {
        results.push({ ...f, error: e.message });
      }
    }
  }),
);
const failed = results.filter((r) => r.error);
const missing = results.filter((r) => !r.error && !have.has(r.filename));
console.log(
  `manifest ${results.length} | resolved ${results.length - failed.length} | unresolved ${failed.length} | not in library ${missing.length}`,
);
for (const f of failed) console.log("  unresolved:", f.projectID, f.fileID, f.error);
writeFileSync("cf-resolved.json", JSON.stringify(results, null, 1));

const added = [];
const skippedVersionOnly = [];
for (const m of missing) {
  // Same mod, different version already present? (name minus version-ish tail) -> keep ours, note it.
  const stem = m.filename
    .toLowerCase()
    .replace(/[-_ ]?(forge|fabric)?[-_ ]?v?\d[\w.+-]*\.jar$/i, "");
  const sameStem = lib.find((x) => x.file.toLowerCase().startsWith(stem) && stem.length > 4);
  if (sameStem) {
    skippedVersionOnly.push(`${m.filename} (have ${sameStem.file})`);
    continue;
  }
  const buf = Buffer.from(await (await fetch(m.url, { headers: UA })).arrayBuffer());
  if (buf.length < 1000) {
    console.log("  tiny/blocked download:", m.filename, buf.length);
    continue;
  }
  const fd = new FormData();
  fd.append("files", new Blob([buf]), m.filename);
  const up = await (await fetch(`${B}/mods`, { method: "POST", body: fd })).json();
  const entry = up.added?.[0];
  if (!entry) {
    console.log("  upload failed:", m.filename, JSON.stringify(up));
    continue;
  }
  for (const side of ["server", "client"]) {
    await fetch(`${B}/profiles/${profileId}/mods`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: m.filename, enabled: true, side }),
    });
  }
  added.push(`${entry.id}@${entry.version} [${entry.loaders.join("+")}] ${m.filename}`);
}
console.log(`\nadded ${added.length}:`);
for (const a of added) console.log("  +", a);
console.log(`\nskipped (different version already in library) ${skippedVersionOnly.length}:`);
for (const s of skippedVersionOnly) console.log("  ~", s);
const p = await (await fetch(`${B}/profiles/${profileId}`)).json();
console.log(`\nprofile ${p.id}: server ${p.enabledMods.length}, client ${p.clientMods.length}`);
