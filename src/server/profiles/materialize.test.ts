import { describe, expect, it } from "vitest";
import path from "node:path";
import { planMods } from "./materialize.ts";

describe("planMods", () => {
  const lib = "/lib";
  const mods = "/srv/mods";

  it("removes every existing jar and links every enabled library jar", () => {
    const plan = planMods(["a.jar", "b.jar"], new Set(["a.jar", "b.jar", "c.jar"]), lib, mods, [
      "old.jar",
      "a.jar",
      "notes.txt",
    ]);
    expect(plan.unlink).toEqual([path.join(mods, "old.jar"), path.join(mods, "a.jar")]);
    expect(plan.link).toEqual([
      [path.join(lib, "a.jar"), path.join(mods, "a.jar")],
      [path.join(lib, "b.jar"), path.join(mods, "b.jar")],
    ]);
    expect(plan.missing).toEqual([]);
  });

  it("reports enabled mods missing from the library instead of failing", () => {
    const plan = planMods(["gone.jar"], new Set(), lib, mods, []);
    expect(plan.link).toEqual([]);
    expect(plan.missing).toEqual(["gone.jar"]);
  });

  it("never touches non-jar files in the server mods dir", () => {
    const plan = planMods([], new Set(), lib, mods, ["config.toml", "README"]);
    expect(plan.unlink).toEqual([]);
  });
});
