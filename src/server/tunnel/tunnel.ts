import path from "node:path";
import type { TunnelMode, TunnelState } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { readJson, writeJsonAtomic } from "../fsx.ts";
import type { LogBuffer } from "../process/log-buffer.ts";
import { PlayitProvider } from "./playit-provider.ts";

interface TunnelConfig {
  mode: TunnelMode;
  /** external mode: what the user pasted. playit mode: last address seen. */
  publicAddress: string | null;
  tunnelId: string | null;
}

/**
 * Owns the "how does John get in" question. `playit` mode drives the bundled agent; `external`
 * mode is the escape hatch (user runs anything they like and pastes the address in). The
 * management UI port is never tunnelled, only the game port.
 */
export class TunnelManager {
  readonly playit: PlayitProvider;
  private readonly configFile: string;
  private config: TunnelConfig = { mode: "off", publicAddress: null, tunnelId: null };
  private error: string | null = null;
  private starting: Promise<TunnelState> | null = null;
  private generation = 0;

  constructor(playitDir: string, logs: LogBuffer) {
    this.playit = new PlayitProvider(playitDir, logs);
    this.configFile = path.join(playitDir, "tunnel.json");
  }

  async init(): Promise<void> {
    this.config = {
      ...this.config,
      ...(await readJson<Partial<TunnelConfig>>(this.configFile, {})),
    };
  }

  async getState(): Promise<TunnelState> {
    const binaryPresent = await this.playit.binaryPresent();
    const secretPresent = await this.playit.secretPresent();
    const claim = this.playit.claimProgress();
    const base: TunnelState = {
      mode: this.config.mode,
      status: "off",
      binaryPresent,
      secretPresent,
      claim: claim ? { code: claim.code, url: claim.url, startedAt: claim.startedAt } : null,
      publicAddress: this.config.publicAddress,
      tunnelId: this.config.tunnelId,
      error: this.error ?? this.playit.lastError,
      pid: this.playit.pid,
    };
    if (this.config.mode === "off") return base;
    if (this.config.mode === "external")
      return { ...base, status: this.config.publicAddress ? "configured" : "stopped" };
    // playit
    if (base.error) return { ...base, status: "error" };
    if (!binaryPresent) return { ...base, status: "not_installed" };
    if (claim?.result === "pending") return { ...base, status: "claiming" };
    if (claim?.result === "error")
      return { ...base, status: "error", error: claim.error ?? "claim failed" };
    if (!secretPresent) return { ...base, status: "unclaimed" };
    if (this.starting) return { ...base, status: "starting" };
    return {
      ...base,
      status: this.playit.running ? "running" : "stopped",
      publicAddress: this.config.publicAddress ?? this.playit.lastLoggedAddress,
    };
  }

  async setMode(mode: TunnelMode, address?: string): Promise<void> {
    if (mode === "external" && address !== undefined) {
      const a = address.trim();
      if (a && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(a))
        throw badRequest("BAD_ADDRESS", "Address must look like host or host:port");
      this.config.publicAddress = a || null;
    }
    if (mode !== this.config.mode && this.config.mode === "playit") await this.stop();
    this.config.mode = mode;
    this.error = null;
    await this.save();
  }

  async install(): Promise<{ file: string; bytes: number }> {
    this.error = null;
    return this.playit.install();
  }

  async startClaim() {
    this.error = null;
    return this.playit.startClaim();
  }

  async start(): Promise<TunnelState> {
    if (this.config.mode !== "playit") throw badRequest("TUNNEL_MODE", "Tunnel mode is not playit");
    if (this.starting) {
      await this.starting;
      return this.getState();
    }
    if (this.playit.running) return this.getState();
    this.starting = this.startInternal(this.generation);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    return this.getState();
  }

  private async startInternal(generation: number): Promise<TunnelState> {
    this.error = null;
    try {
      // Keep the previously claimed tunnel and address; restarting the local agent need not
      // call the provisioning API or risk creating a replacement tunnel.
      const t =
        this.config.tunnelId && this.config.publicAddress
          ? null
          : await this.playit.prepareTunnel();
      if (generation !== this.generation) return this.getState();
      if (t) {
        this.config.tunnelId = t.id;
        this.config.publicAddress = t.address;
        await this.save();
      }
      if (generation === this.generation) await this.playit.start();
    } catch (err) {
      this.error = (err as Error).message;
    }
    return this.getState();
  }

  async stop(): Promise<TunnelState> {
    this.generation++;
    await this.starting;
    await this.playit.stop();
    return this.getState();
  }

  killSync(): void {
    this.playit.killSync();
  }

  private save(): Promise<void> {
    return writeJsonAtomic(this.configFile, this.config);
  }
}
