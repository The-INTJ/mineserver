import { describe, expect, it } from "vitest";
import {
  installSpec,
  javaMajorFor,
  launchArgs,
  loaderCompatible,
  parseRuntimeId,
  runtimeId,
} from "./runtimes.ts";

describe("runtimes", () => {
  it("maps Minecraft versions to the Java major Mojang requires", () => {
    expect(javaMajorFor("1.16.5")).toBe(8);
    expect(javaMajorFor("1.17.1")).toBe(16);
    expect(javaMajorFor("1.18.2")).toBe(17);
    expect(javaMajorFor("1.20.1")).toBe(17);
    expect(javaMajorFor("1.20.4")).toBe(17);
    expect(javaMajorFor("1.20.5")).toBe(21);
    expect(javaMajorFor("1.21.1")).toBe(21);
    expect(javaMajorFor("26.2")).toBe(25);
  });

  it("builds ids and install specs per loader", () => {
    const forge = { loader: "forge" as const, minecraft: "1.20.1", loaderVersion: "47.4.0" };
    expect(runtimeId(forge)).toBe("forge-1.20.1");
    expect(parseRuntimeId("forge-1.20.1")).toEqual({ loader: "forge", minecraft: "1.20.1" });
    expect(parseRuntimeId("nope")).toBeNull();
    const spec = installSpec(forge);
    expect(spec.kind).toBe("installer");
    expect(spec.url).toBe(
      "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar",
    );
    const fabric = installSpec({ loader: "fabric", minecraft: "26.2", loaderVersion: "0.19.5" });
    expect(fabric.kind).toBe("launcher");
    expect(fabric.url).toContain("/loader/26.2/0.19.5/");
  });

  it("launches Forge through its args file and Fabric through the launcher jar", () => {
    const forge = launchArgs(
      { loader: "forge", minecraft: "1.20.1", loaderVersion: "47.4.0" },
      "/srv",
    );
    expect(forge[0]).toMatch(
      /^@libraries\/net\/minecraftforge\/forge\/1\.20\.1-47\.4\.0\/(win|unix)_args\.txt$/,
    );
    expect(forge[1]).toBe("nogui");
    const fabric = launchArgs(
      { loader: "fabric", minecraft: "26.2", loaderVersion: "0.19.5" },
      "/srv",
    );
    expect(fabric).toEqual(["-jar", expect.stringMatching(/fabric-server-launch\.jar$/), "nogui"]);
  });

  it("refuses jars built for another loader", () => {
    const forge = { loader: "forge" as const, minecraft: "1.20.1", loaderVersion: "47.4.0" };
    expect(loaderCompatible(["forge"], forge)).toBe(true);
    expect(loaderCompatible(["fabric"], forge)).toBe(false);
    expect(loaderCompatible(["fabric", "forge"], forge)).toBe(true);
    expect(loaderCompatible([], forge)).toBe(true);
    expect(
      loaderCompatible(["forge"], {
        loader: "neoforge",
        minecraft: "1.21.1",
        loaderVersion: "21.1.209",
      }),
    ).toBe(false);
  });
});
