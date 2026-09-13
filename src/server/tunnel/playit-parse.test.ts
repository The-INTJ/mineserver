import { describe, expect, it } from "vitest";
import {
  parseAddressFromAgentLog,
  parseClaimCode,
  parseClaimUrl,
  parseSecret,
  parseTunnelsList,
} from "./playit-parse.ts";

describe("playit-parse", () => {
  it("parses tunnels list lines", () => {
    const out = `
7a1b2c3d-1111-2222-3333-444455556666 tcp 1 friendly-name.gl.joinmc.link:12345
some-banner-line
`;
    expect(parseTunnelsList(out)).toEqual([
      {
        id: "7a1b2c3d-1111-2222-3333-444455556666",
        portType: "tcp",
        portCount: 1,
        address: "friendly-name.gl.joinmc.link:12345",
      },
    ]);
  });

  it("parses claim code, url and secret from noisy output", () => {
    expect(parseClaimCode("playit 0.17.1\nAbCd1234efGH\n")).toBe("AbCd1234efGH");
    expect(parseClaimUrl("Visit https://playit.gg/claim/AbCd1234efGH to approve\n")).toBe(
      "https://playit.gg/claim/AbCd1234efGH",
    );
    expect(parseSecret("waiting...\n" + "a".repeat(64) + "\n")).toBe("a".repeat(64));
    expect(parseSecret("error: timeout")).toBeNull();
  });

  it("spots a public address in agent log lines", () => {
    expect(
      parseAddressFromAgentLog("tunnel ready: play.gl.joinmc.link:41234 -> 127.0.0.1:25565"),
    ).toBe("play.gl.joinmc.link:41234");
    expect(parseAddressFromAgentLog("nothing here")).toBeNull();
  });
});
