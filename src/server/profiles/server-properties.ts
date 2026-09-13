/**
 * Minimal server.properties codec that preserves comments and ordering so diffs stay readable.
 * Keys mineserver owns are forced on every write, whatever the profile says.
 */

export const FORCED_PROPERTIES: Record<string, string> = {
  // The active world is always the `world` junction under data/server.
  "level-name": "world",
  // The tunnel address is public; the whitelist is the only thing keeping strangers out.
  "white-list": "true",
  "enforce-whitelist": "true",
};

export interface PropertiesDoc {
  lines: string[];
}

export function parseProperties(text: string): PropertiesDoc {
  return { lines: text.split(/\r?\n/) };
}

export function toRecord(doc: PropertiesDoc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of doc.lines) {
    const kv = splitLine(line);
    if (kv) out[kv[0]] = kv[1];
  }
  return out;
}

/** Apply overrides in place: existing keys are rewritten where they are; new keys are appended. */
export function mergeProperties(
  doc: PropertiesDoc,
  overrides: Record<string, string>,
): PropertiesDoc {
  const lines = [...doc.lines];
  const pending = new Map(Object.entries(overrides));
  for (let i = 0; i < lines.length; i++) {
    const kv = splitLine(lines[i]);
    if (!kv) continue;
    const v = pending.get(kv[0]);
    if (v !== undefined) {
      lines[i] = `${kv[0]}=${v}`;
      pending.delete(kv[0]);
    }
  }
  if (pending.size > 0 && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  return { lines };
}

export function serializeProperties(doc: PropertiesDoc): string {
  const body = doc.lines.join("\n");
  return body.endsWith("\n") ? body : body + "\n";
}

/** Template + profile overrides + forced keys. */
export function buildServerProperties(
  template: string,
  overrides: Record<string, string>,
): { text: string; effective: Record<string, string> } {
  const merged = mergeProperties(parseProperties(template), { ...overrides, ...FORCED_PROPERTIES });
  return { text: serializeProperties(merged), effective: toRecord(merged) };
}

function splitLine(line: string): [string, string] | null {
  const t = line.trim();
  if (!t || t.startsWith("#") || t.startsWith("!")) return null;
  const idx = t.search(/[=:]/);
  if (idx <= 0) return null;
  return [t.slice(0, idx).trim(), t.slice(idx + 1).trim()];
}
