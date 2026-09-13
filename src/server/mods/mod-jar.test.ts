import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeJar } from "../../../test/make-jar.ts";
import { parseModJson, readFabricModJson } from "./mod-jar.ts";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mineserver-jar-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readFabricModJson", () => {
  it("reads id/version/environment from a jar", async () => {
    const p = path.join(dir, "iris.jar");
    await makeJar(p, {
      "fabric.mod.json": JSON.stringify({
        id: "iris",
        version: "1.0",
        name: "Iris",
        environment: "client",
      }),
    });
    expect(await readFabricModJson(p)).toEqual({
      ok: true,
      id: "iris",
      version: "1.0",
      name: "Iris",
      environment: "client",
    });
  });

  it("defaults environment to * and name to id", async () => {
    const p = path.join(dir, "cloth.jar");
    await makeJar(p, { "fabric.mod.json": JSON.stringify({ id: "cloth-config", version: "2" }) });
    expect(await readFabricModJson(p)).toMatchObject({
      ok: true,
      name: "cloth-config",
      environment: "*",
    });
  });

  it("fails gracefully for jars without fabric.mod.json and for non-zips", async () => {
    const p = path.join(dir, "plain.jar");
    await makeJar(p, { "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" });
    expect(await readFabricModJson(p)).toMatchObject({ ok: false });
    const bad = path.join(dir, "bad.jar");
    await fs.writeFile(bad, "not a zip");
    expect(await readFabricModJson(bad)).toMatchObject({ ok: false });
  });

  it("parseModJson tolerates a BOM and rejects missing fields", () => {
    expect(parseModJson('﻿{"id":"x","version":"1"}')).toMatchObject({ ok: true, id: "x" });
    expect(parseModJson('{"id":"x"}')).toMatchObject({ ok: false });
  });
});
