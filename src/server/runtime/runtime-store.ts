import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Runtime, RuntimeInfo } from "../../shared/types.ts";
import {
  listJavas,
  pickJava,
  runtimePaths,
  type JavaCandidate,
  type RuntimePaths,
} from "../config.ts";
import { conflict } from "../errors.ts";
import { eulaAccepted, writeEula } from "../fabric/eula.ts";
import { probeJava } from "../fabric/java-info.ts";
import { exists } from "../fsx.ts";
import type { LogBuffer } from "../process/log-buffer.ts";
import { installSpec, installedMarker, javaMajorFor, launchArgs, runtimeId } from "./runtimes.ts";

/**
 * Owns data/servers/<runtime>/: install status, the right JDK, and how to launch. One runtime dir
 * per (loader, minecraft) so Forge's and Fabric's libraries/, configs and logs never mix.
 */
export class RuntimeStore {
  private javas: JavaCandidate[] | null = null;

  constructor(
    private readonly serversRoot: string,
    private readonly logs: LogBuffer,
  ) {}

  paths(rt: Runtime): RuntimePaths {
    return runtimePaths(this.serversRoot, runtimeId(rt));
  }

  async installed(rt: Runtime): Promise<boolean> {
    return exists(path.join(this.paths(rt).dir, installedMarker(rt)));
  }

  async javaFor(
    rt: Runtime,
  ): Promise<{ path: string | null; version: string | null; ok: boolean; major: number }> {
    const major = javaMajorFor(rt.minecraft);
    if (!this.javas) this.javas = await listJavas();
    const pick = pickJava(this.javas, major);
    if (!pick) return { path: null, version: null, ok: false, major };
    const info = await probeJava(pick.exe);
    // Fabric on the newest Minecraft is happy on anything ≥ required. Forge/NeoForge pin their
    // toolchain (ASM, module hacks) and break on newer majors, so require an exact match there.
    const ok =
      info.major !== null && (rt.loader === "fabric" ? info.major >= major : info.major === major);
    return { path: pick.exe, version: info.version, ok, major };
  }

  async info(rt: Runtime): Promise<RuntimeInfo> {
    const java = await this.javaFor(rt);
    const p = this.paths(rt);
    return {
      ...rt,
      id: runtimeId(rt),
      dir: p.dir,
      installed: await this.installed(rt),
      javaMajor: java.major,
      javaPath: java.path,
      javaVersion: java.version,
      javaOk: java.ok,
      eulaAccepted: await eulaAccepted(p.dir),
    };
  }

  /** Every runtime dir that exists on disk, whether or not a profile still references it. */
  async listInstalledIds(): Promise<string[]> {
    const names = await fs.readdir(this.serversRoot).catch(() => [] as string[]);
    return names.filter((n) => /^(fabric|forge|neoforge)-/.test(n)).sort();
  }

  /**
   * Download and, for Forge/NeoForge, run the installer. Long-running (the installer pulls ~100
   * libraries); progress goes to the log buffer and `onMessage`.
   */
  async install(
    rt: Runtime,
    onMessage: (m: string) => void = () => undefined,
  ): Promise<RuntimeInfo> {
    const p = this.paths(rt);
    await fs.mkdir(p.dir, { recursive: true });
    const spec = installSpec(rt);
    const dest = path.join(p.dir, spec.file);
    const say = (m: string) => {
      this.logs.note(`[${runtimeId(rt)}] ${m}`);
      onMessage(m);
    };

    if (!(await exists(dest))) {
      say(`downloading ${spec.url}`);
      const res = await fetch(spec.url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${spec.url} returned ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 10_000) throw new Error(`download too small (${buf.length} bytes)`);
      await fs.writeFile(`${dest}.part`, buf);
      await fs.rename(`${dest}.part`, dest);
      say(`downloaded ${spec.file} (${(buf.length / 1e6).toFixed(1)} MB)`);
    }

    if (spec.kind === "installer" && !(await this.installed(rt))) {
      const java = await this.javaFor(rt);
      if (!java.path || !java.ok) {
        throw conflict(
          "JAVA_UNSUPPORTED",
          `Need Java ${java.major} for ${runtimeId(rt)}; found ${java.version ?? "none"}`,
        );
      }
      say(`running installer with ${java.path} (this takes a few minutes)`);
      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          java.path!,
          ["-jar", dest, "--installServer", p.dir],
          { cwd: p.dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 },
          (err, stdout, stderr) => {
            const tail = (stdout + "\n" + stderr).trim().split(/\r?\n/).slice(-15).join("\n");
            if (err) reject(new Error(`installer failed: ${err.message}\n${tail}`));
            else {
              say(`installer finished: ${tail.split("\n").slice(-1)[0]}`);
              resolve();
            }
          },
        );
        child.stdout?.on("data", (d: Buffer) => {
          for (const line of d.toString("utf8").split(/\r?\n/)) {
            if (/Downloading|Extracting|successfully|Installing/i.test(line))
              onMessage(line.trim());
          }
        });
      });
      // The installer writes run.bat/run.sh and a "user_jvm_args.txt"; we pass memory args
      // ourselves and leave that file as the installer wrote it.
    }
    if (!(await this.installed(rt)))
      throw new Error(`install finished but ${installedMarker(rt)} is missing`);
    return this.info(rt);
  }

  /** Java + argv for this runtime, given the profile's JVM settings. */
  async launchSpec(
    rt: Runtime,
    jvm: { maxMemoryGb: number; extraArgs: string[] },
  ): Promise<{ javaPath: string; args: string[] }> {
    const java = await this.javaFor(rt);
    if (!java.path || !java.ok) {
      throw conflict(
        "JAVA_UNSUPPORTED",
        `Need Java ${java.major} for ${runtimeId(rt)}; found ${java.version ?? "none"}`,
      );
    }
    const gb = Math.max(1, Math.round(jvm.maxMemoryGb));
    return {
      javaPath: java.path,
      args: [
        `-Xms${Math.min(gb, 2)}G`,
        `-Xmx${gb}G`,
        // Player names and chat can be non-ASCII; without these Windows Java writes cp1252.
        "-Dfile.encoding=UTF-8",
        "-Dstdout.encoding=UTF-8",
        ...jvm.extraArgs,
        ...launchArgs(rt, this.paths(rt).dir),
      ],
    };
  }

  /** Mirror the one-time EULA acceptance into a runtime dir that doesn't have it yet. */
  async ensureEula(rt: Runtime, accepted: boolean): Promise<void> {
    const p = this.paths(rt);
    if (accepted && !(await eulaAccepted(p.dir))) {
      await fs.mkdir(p.dir, { recursive: true });
      await writeEula(p.dir, true);
    }
  }

  resetJavaCache(): void {
    this.javas = null;
  }
}
