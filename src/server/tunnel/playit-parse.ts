/**
 * Pure parsers for playit CLI output (v0.17.x). Isolated so the format can be pinned by tests
 * and fixed in one place when a version bump changes it.
 */

export interface TunnelListEntry {
  id: string;
  portType: string;
  portCount: number;
  address: string;
}

const nonEmptyLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** `tunnels list` prints one tunnel per line: `<id> <port-type> <port-count> <public-address>`. */
export function parseTunnelsList(text: string): TunnelListEntry[] {
  const out: TunnelListEntry[] = [];
  for (const line of nonEmptyLines(text)) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const count = Number(parts[2]);
    if (!/^[0-9a-f-]{8,}$/i.test(parts[0]) || !Number.isFinite(count)) continue;
    out.push({ id: parts[0], portType: parts[1], portCount: count, address: parts[3] });
  }
  return out;
}

/** `claim generate` prints just the code; take the last non-empty token to survive banner lines. */
export function parseClaimCode(text: string): string | null {
  const lines = nonEmptyLines(text);
  const last = lines[lines.length - 1];
  return last && /^[A-Za-z0-9_-]{6,}$/.test(last) ? last : null;
}

export function parseClaimUrl(text: string): string | null {
  const m = /https?:\/\/\S+/.exec(text);
  return m ? m[0] : null;
}

/** `claim exchange` prints the secret key on success. */
export function parseSecret(text: string): string | null {
  const lines = nonEmptyLines(text);
  const last = lines[lines.length - 1];
  return last && /^[A-Za-z0-9_+/=-]{32,}$/.test(last) ? last : null;
}

/** The agent logs the public address once connected; used as a fallback to `tunnels list`. */
export function parseAddressFromAgentLog(line: string): string | null {
  const m = /([a-z0-9.-]+\.(?:joinmc\.link|playit\.gg|ply\.gg)(?::\d+)?)/i.exec(line);
  return m ? m[1] : null;
}
