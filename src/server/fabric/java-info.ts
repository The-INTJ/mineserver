import { execFile } from "node:child_process";

export interface JavaInfo {
  path: string;
  version: string | null;
  major: number | null;
  ok: boolean;
  error?: string;
}

/** Minecraft 26.x requires Java 25+. */
export const REQUIRED_JAVA_MAJOR = 25;

let cache: JavaInfo | null = null;

export async function probeJava(javaPath: string): Promise<JavaInfo> {
  if (cache && cache.path === javaPath) return cache;
  const info = await new Promise<JavaInfo>((resolve) => {
    // `java -version` prints to stderr.
    execFile(javaPath, ["-version"], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ path: javaPath, version: null, major: null, ok: false, error: err.message });
        return;
      }
      const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(stderr);
      const major = m ? (m[1] === "1" ? Number(m[2]) : Number(m[1])) : null;
      const version = m ? m[0].slice(9, -1) : null;
      resolve({
        path: javaPath,
        version,
        major,
        ok: major !== null && major >= REQUIRED_JAVA_MAJOR,
      });
    });
  });
  cache = info;
  return info;
}

export function resetJavaCache(): void {
  cache = null;
}
