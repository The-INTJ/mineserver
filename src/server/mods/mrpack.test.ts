import { describe, expect, it } from "vitest";
import { planMrpack, type MrpackIndex } from "./mrpack.ts";

const index: MrpackIndex = {
  formatVersion: 1,
  game: "minecraft",
  versionId: "4.1.5",
  name: "Society: Sunlit Valley",
  dependencies: { minecraft: "1.20.1", forge: "47.4.0" },
  files: [
    { path: "mods/create.jar", hashes: {}, downloads: ["https://cdn.modrinth.com/x/create.jar"] },
    {
      path: "mods/oculus.jar",
      hashes: {},
      env: { client: "required", server: "unsupported" },
      downloads: ["u"],
    },
    {
      path: "mods/server-tool.jar",
      hashes: {},
      env: { client: "unsupported", server: "required" },
      downloads: ["u"],
    },
    { path: "resourcepacks/pretty.zip", hashes: {}, downloads: ["u"] },
    {
      path: "shaderpacks/bsl.zip",
      hashes: {},
      env: { client: "optional", server: "unsupported" },
      downloads: ["u"],
    },
  ],
};

describe("planMrpack", () => {
  it("derives the runtime and splits server vs client-only jars", () => {
    const plan = planMrpack(index);
    expect(plan.runtime).toEqual({ loader: "forge", minecraft: "1.20.1", loaderVersion: "47.4.0" });
    expect(plan.serverFiles.map((f) => f.path)).toEqual([
      "mods/create.jar",
      "mods/server-tool.jar",
    ]);
    expect(plan.clientFiles.map((f) => f.path)).toEqual(["mods/oculus.jar"]);
    expect(plan.nonMods).toEqual(["resourcepacks/pretty.zip", "shaderpacks/bsl.zip"]);
  });

  it("recognises fabric and neoforge packs", () => {
    expect(
      planMrpack({ ...index, dependencies: { minecraft: "26.2", "fabric-loader": "0.19.5" } })
        .runtime.loader,
    ).toBe("fabric");
    expect(
      planMrpack({ ...index, dependencies: { minecraft: "1.21.1", neoforge: "21.1.209" } }).runtime
        .loader,
    ).toBe("neoforge");
    expect(() => planMrpack({ ...index, dependencies: { minecraft: "1.20.1" } })).toThrow(/loader/);
  });
});
