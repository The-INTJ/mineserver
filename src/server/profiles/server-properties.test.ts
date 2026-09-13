import { describe, expect, it } from "vitest";
import {
  buildServerProperties,
  mergeProperties,
  parseProperties,
  serializeProperties,
  toRecord,
} from "./server-properties.ts";

const TEMPLATE = `# comment
level-name=world
white-list=true
motd=mineserver
max-players=10
`;

describe("server-properties", () => {
  it("preserves comments and order when merging", () => {
    const merged = mergeProperties(parseProperties(TEMPLATE), {
      motd: "hello",
      "view-distance": "12",
    });
    expect(serializeProperties(merged)).toBe(`# comment
level-name=world
white-list=true
motd=hello
max-players=10
view-distance=12
`);
  });

  it("forces level-name and white-list regardless of overrides", () => {
    const { effective } = buildServerProperties(TEMPLATE, {
      "level-name": "../somewhere",
      "white-list": "false",
      "max-players": "3",
    });
    expect(effective["level-name"]).toBe("world");
    expect(effective["white-list"]).toBe("true");
    expect(effective["enforce-whitelist"]).toBe("true");
    expect(effective["max-players"]).toBe("3");
  });

  it("parses keys with = or : and ignores comments", () => {
    expect(toRecord(parseProperties("a=1\n! bang\nb: 2\n#c=3\n"))).toEqual({ a: "1", b: "2" });
  });
});

describe("buildServerProperties level-name", () => {
  it("uses the relative world path when asked (Forge/NeoForge runtimes)", () => {
    const { effective } = buildServerProperties(
      "level-name=world\n",
      {},
      "../../worlds/sunlit-valley",
    );
    expect(effective["level-name"]).toBe("../../worlds/sunlit-valley");
  });
});
