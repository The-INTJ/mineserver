import type { PersistedState } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./fsx.ts";

const DEFAULT: PersistedState = { activeProfileId: null, lastStartedAt: null, eulaAccepted: false };

/** data/state.json: the few things that must survive a daemon restart. */
export class StateStore {
  private cache: PersistedState | null = null;
  constructor(private readonly file: string) {}

  async get(): Promise<PersistedState> {
    if (!this.cache) {
      const stored = await readJson<Partial<PersistedState>>(this.file, {});
      this.cache = { ...DEFAULT, ...stored };
    }
    return this.cache;
  }

  async patch(update: Partial<PersistedState>): Promise<PersistedState> {
    const next = { ...(await this.get()), ...update };
    this.cache = next;
    await writeJsonAtomic(this.file, next);
    return next;
  }
}
