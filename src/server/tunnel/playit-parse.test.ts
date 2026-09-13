import { describe, expect, it } from "vitest";
import {
  parseAddressFromAgentLog,
  parseClaimCode,
  parseClaimUrl,
  parseSecret,
  parseTunnelsList,
  stripTui,
} from "./playit-parse.ts";

// Captured from the real playit-0.17.1 binary with stdout piped: it still paints a TUI.
const ESC = "\x1b";
const TUI_CLAIM_GENERATE =
  `${ESC}[?1049h${ESC}[10;1H${ESC}[38;5;5;49m┌ playit.gg ────────────┐${ESC}[11;1H│${ESC}[11;56H${ESC}[38;5;15;49m3949e5b31e${ESC}[11;120H${ESC}[38;5;5;49m│${ESC}[12;1H│${ESC}[12;120H│` +
  `${ESC}[29;1H└──────────────────────┘${ESC}[30;1H${ESC}[38;5;8;49m  ${ESC}[1m${ESC}[38;5;6;49mj/k${ESC}[22m${ESC}[38;5;8;49m Scroll  q Quit ${ESC}[39m${ESC}[49m${ESC}[59m${ESC}[0m${ESC}[?25l${ESC}[?1049l${ESC}[?25h`;
const TUI_CLAIM_URL = `${ESC}[?1049h┌ playit.gg ──┐│https://playit.gg/claim/3949e5b31e│││└───┘ j/k Scroll Tab Switch Panel g/G Top/Bottom q Quit ${ESC}[?1049l`;

describe("playit-parse", () => {
  it("strips ANSI escapes and box drawing", () => {
    expect(stripTui(TUI_CLAIM_GENERATE)).toContain("3949e5b31e");
    // eslint-disable-next-line no-control-regex -- asserting the escape byte is gone
    expect(stripTui(TUI_CLAIM_GENERATE)).not.toMatch(/\x1b|[─│┌┐└┘]/);
  });

  it("finds the claim code inside the TUI output", () => {
    expect(parseClaimCode(TUI_CLAIM_GENERATE)).toBe("3949e5b31e");
    expect(parseClaimCode("playit 0.17.1\nAbCd1234efGH\n")).toBeNull(); // not hex
    expect(parseClaimCode("nothing")).toBeNull();
  });

  it("finds the claim URL inside the TUI output", () => {
    expect(parseClaimUrl(TUI_CLAIM_URL)).toBe("https://playit.gg/claim/3949e5b31e");
    expect(parseClaimUrl("Error: InvalidClaimCode")).toBeNull();
  });

  it("parses tunnels list lines, decorated or not", () => {
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
    expect(parseTunnelsList(`${ESC}[?1049h│${out}│${ESC}[?1049l`)).toHaveLength(1);
  });

  it("extracts the secret as the longest key-like token", () => {
    const secret = "a".repeat(64);
    expect(parseSecret(`waiting...\n${secret}\n`)).toBe(secret);
    expect(parseSecret(`${ESC}[1m│ ${secret} │${ESC}[0m`)).toBe(secret);
    expect(parseSecret("error: timeout")).toBeNull();
  });

  it("spots a public address in agent log lines", () => {
    expect(
      parseAddressFromAgentLog("tunnel ready: play.gl.joinmc.link:41234 -> 127.0.0.1:25565"),
    ).toBe("play.gl.joinmc.link:41234");
    expect(parseAddressFromAgentLog("nothing here")).toBeNull();
  });
});
