// Usage: node add-mod.mjs <modrinth query or slug> <profileId> [loader] [mcVersion]
// Finds the mod on Modrinth, downloads the newest matching jar, uploads it into mineserver's
// library and enables it (server + client) in the profile.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const [query, profileId, loader = "forge", mc = "1.20.1"] = process.argv.slice(2);
const B = "http://127.0.0.1:3400/api";
const UA = { "user-agent": "mineserver/0.1 (drew@taylorspot.com)" };
const facets = encodeURIComponent(
  JSON.stringify([["project_type:mod"], [`categories:${loader}`], [`versions:${mc}`]]),
);
const search = await (
  await fetch(
    `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${facets}&limit=5`,
    { headers: UA },
  )
).json();
for (const h of search.hits)
  console.log("  hit:", h.slug, "|", h.title, "|", h.author, "|", h.downloads);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const pick =
  search.hits.find(
    (h) => norm(h.title).startsWith(norm(query)) || norm(h.slug).startsWith(norm(query)),
  ) ?? search.hits[0];
if (!pick) throw new Error("no hits");
const versions = await (
  await fetch(
    `https://api.modrinth.com/v2/project/${pick.project_id}/version?loaders=${encodeURIComponent(JSON.stringify([loader]))}&game_versions=${encodeURIComponent(JSON.stringify([mc]))}`,
    { headers: UA },
  )
).json();
const v = versions[0];
if (!v) throw new Error(`no ${loader} ${mc} version for ${pick.slug}`);
const file = v.files.find((f) => f.primary) ?? v.files[0];
console.log("picked:", pick.slug, v.version_number, file.filename);
const buf = Buffer.from(await (await fetch(file.url, { headers: UA })).arrayBuffer());
writeFileSync(file.filename, buf);
const fd = new FormData();
fd.append("files", new Blob([buf]), basename(file.filename));
const added = await (await fetch(`${B}/mods`, { method: "POST", body: fd })).json();
console.log("library:", JSON.stringify(added.added?.[0] ?? added));
for (const side of ["server", "client"]) {
  const r = await fetch(`${B}/profiles/${profileId}/mods`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: file.filename, enabled: true, side }),
  });
  if (!r.ok) console.log(side, "toggle failed", await r.text());
}
const p = await (await fetch(`${B}/profiles/${profileId}`)).json();
console.log(
  "profile:",
  p.id,
  "server mods",
  p.enabledMods.length,
  "client mods",
  p.clientMods.length,
);
