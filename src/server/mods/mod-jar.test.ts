import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeJar } from "../../../test/make-jar.ts";
import { parseFabricModJson, parseModsToml, readModManifest } from "./mod-jar.ts";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineserver-jar-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const MODS_TOML = `
modLoader="javafml" #mandatory
loaderVersion="[47,)"
license="MIT"
[[mods]] #mandatory
modId="glyptodon" #mandatory
version="\${file.jarVersion}"
displayName="Glyptodon"
[[dependencies.glyptodon]]
modId="forge"
`;

describe("readModManifest", () => {
  it("reads a Fabric jar", async () => {
    const p = path.join(dir, "iris.jar");
    await makeJar(p, {
      "fabric.mod.json": JSON.stringify({
        id: "iris",
        version: "1.0",
        name: "Iris",
        environment: "client",
      }),
    });
    expect(await readModManifest(p)).toEqual({
      ok: true,
      id: "iris",
      version: "1.0",
      name: "Iris",
      loader: "fabric",
      loaders: ["fabric"],
      environment: "client",
    });
  });

  it("reads a Forge jar via META-INF/mods.toml", async () => {
    const p = path.join(dir, "forge.jar");
    await makeJar(p, { "META-INF/mods.toml": MODS_TOML });
    expect(await readModManifest(p)).toMatchObject({
      ok: true,
      id: "glyptodon",
      name: "Glyptodon",
      loader: "forge",
      version: "?",
    });
  });

  it("records every loader a multi-manifest jar supports", async () => {
    const p = path.join(dir, "multi.jar");
    await makeJar(p, {
      "fabric.mod.json": JSON.stringify({ id: "glyptodon", version: "1.0", name: "Glyptodon" }),
      "META-INF/mods.toml": MODS_TOML,
      "META-INF/neoforge.mods.toml": MODS_TOML,
    });
    const r = await readModManifest(p);
    expect(r).toMatchObject({ ok: true, id: "glyptodon", loader: "multi", version: "1.0" });
    expect((r as { loaders: string[] }).loaders.sort()).toEqual(["fabric", "forge", "neoforge"]);
  });

  it("defaults environment to * and name to id", async () => {
    const p = path.join(dir, "cloth.jar");
    await makeJar(p, { "fabric.mod.json": JSON.stringify({ id: "cloth-config", version: "2" }) });
    expect(await readModManifest(p)).toMatchObject({
      ok: true,
      name: "cloth-config",
      environment: "*",
    });
  });

  it("fails gracefully for jars without a manifest and for non-zips", async () => {
    const p = path.join(dir, "plain.jar");
    await makeJar(p, { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" });
    expect(await readModManifest(p)).toMatchObject({ ok: false });
    const bad = path.join(dir, "bad.jar");
    await fs.writeFile(bad, "not a zip");
    expect(await readModManifest(bad)).toMatchObject({ ok: false });
  });

  it("parsers tolerate a BOM and reject missing fields", () => {
    expect(parseFabricModJson('﻿{"id":"x","version":"1"}')).toMatchObject({ ok: true, id: "x" });
    expect(parseFabricModJson('{"id":"x"}')).toMatchObject({ ok: false });
    expect(parseModsToml("modLoader='javafml'\n", "forge")).toMatchObject({ ok: false });
    expect(
      parseModsToml('[[mods]]\nmodId = "a"\nversion = "1.2.3"\n[[mods]]\nmodId="b"', "forge"),
    ).toMatchObject({ ok: true, id: "a", version: "1.2.3" });
  });
});
