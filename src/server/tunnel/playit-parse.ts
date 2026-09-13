/**
 * Pure parsers for playit CLI output (v0.17.x). Isolated so the format can be pinned by tests
 * and fixed in one place when a version bump changes it.
 *
 * Gotcha (verified against the real 0.17.1 binary): even when stdout is a pipe, subcommands like
 * `claim generate` paint a full-screen TUI (alternate screen, box-drawing, colours). The payload
 * is still in there as plain text, so every parser first strips ANSI escapes and box characters
 * and then looks for tokens rather than trusting line structure.
 */

export interface TunnelListEntry {
  id: string;
  portType: string;
  portCount: number;
  address: string;
}

// CSI sequences (`ESC [ ... final`), OSC (`ESC ] ... BEL/ST`), and lone ESC+char.
// eslint-disable-next-line no-control-regex -- matching terminal escapes is the whole point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const BOX = /[─-╿]/g;

/** Strip terminal decoration; returns plain text with whitespace collapsed per line. */
export function stripTui(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(BOX, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const tokens = (text: string) => stripTui(text).split(/\s+/).filter(Boolean);

/** `tunnels list` prints one tunnel per line: `<id> <port-type> <port-count> <public-address>`. */
export function parseTunnelsList(text: string): TunnelListEntry[] {
  const out: TunnelListEntry[] = [];
  for (const line of stripTui(text).split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const count = Number(parts[2]);
    if (!/^[0-9a-f-]{8,}$/i.test(parts[0]) || !Number.isFinite(count)) continue;
    out.push({ id: parts[0], portType: parts[1], portCount: count, address: parts[3] });
  }
  return out;
}

/** `claim generate` yields a short hex code (10 chars on 0.17.1), buried in the TUI. */
export function parseClaimCode(text: string): string | null {
  const hex = tokens(text).filter((t) => /^[0-9a-f]{8,16}$/i.test(t));
  return hex[hex.length - 1] ?? null;
}

export function parseClaimUrl(text: string): string | null {
  const m = /https?:\/\/[^\s"'<>]+/.exec(stripTui(text));
  return m ? m[0] : null;
}

/** `claim exchange` prints the secret key on success: the longest key-looking token. */
export function parseSecret(text: string): string | null {
  const keys = tokens(text).filter((t) => /^[A-Za-z0-9_+/=-]{32,}$/.test(t));
  keys.sort((a, b) => b.length - a.length);
  return keys[0] ?? null;
}

/** The agent logs the public address once connected; used as a fallback to `tunnels list`. */
export function parseAddressFromAgentLog(line: string): string | null {
  const m = /([a-z0-9.-]+\.(?:joinmc\.link|playit\.gg|ply\.gg)(?::\d+)?)/i.exec(stripTui(line));
  return m ? m[1] : null;
}
