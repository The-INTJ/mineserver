import { useCallback, useEffect, useState } from "react";
import type { ImportCandidate, StatusResponse, WorldInfo } from "../../shared/types.ts";
import { api, errMsg, fmtBytes } from "../api.ts";

export function Worlds({ status }: { status: StatusResponse }) {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [activeWorld, setActiveWorld] = useState<string | null>(null);
  const [cands, setCands] = useState<ImportCandidate[]>([]);
  const [savesDir, setSavesDir] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const running = status.server.status !== "stopped" && status.server.status !== "crashed";

  const load = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([
        api.get<{ worlds: WorldInfo[]; activeWorld: string | null }>("/worlds"),
        api.get<{ candidates: ImportCandidate[]; savesDir: string }>("/worlds/import/candidates"),
      ]);
      setWorlds(w.worlds);
      setActiveWorld(w.activeWorld);
      setCands(c.candidates);
      setSavesDir(c.savesDir);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const wrap = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid-2">
      <div className="card">
        <h2>Server worlds</h2>
        <p className="muted">
          Live under <span className="mono">data/worlds</span>. The server sees the active one
          through a junction at <span className="mono">data/server/world</span>.
        </p>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {worlds.map((w) => (
              <tr key={w.name} className={w.name === activeWorld ? "active" : ""}>
                <td className="mono">
                  {w.name}
                  {w.name === activeWorld && (
                    <span className="badge running" style={{ marginLeft: 6 }}>
                      linked
                    </span>
                  )}
                  {!w.hasLevelDat && (
                    <span className="muted"> (empty, generated on first start)</span>
                  )}
                </td>
                <td>{fmtBytes(w.sizeBytes)}</td>
                <td>{w.modifiedAt.slice(0, 16).replace("T", " ")}</td>
                <td>
                  <button
                    className="danger"
                    disabled={running || w.name === activeWorld || !!busy}
                    onClick={() =>
                      confirm(`Delete world ${w.name}? This cannot be undone.`) &&
                      wrap(w.name, () => api.del(`/worlds/${encodeURIComponent(w.name)}`))
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {worlds.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No worlds yet. Start the default profile to generate one, or import a save.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {err && <p className="error">{err}</p>}
      </div>
      <div className="card">
        <h2>Import a single-player save</h2>
        <p className="notice">
          Imports <b>copy</b> the save; your client keeps its own. A world remembers its mods: if
          you later remove a mod that added blocks, those blocks vanish. Keep the profile's mod set
          matched to the world.
        </p>
        <p className="muted mono" style={{ fontSize: 12 }}>
          {savesDir}
        </p>
        <table>
          <thead>
            <tr>
              <th>Save</th>
              <th>Size</th>
              <th>Import as</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cands.map((c) => (
              <tr key={c.name}>
                <td>
                  {c.name}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {c.modifiedAt.slice(0, 16).replace("T", " ")}
                  </div>
                </td>
                <td>{fmtBytes(c.sizeBytes)}</td>
                <td>
                  <input
                    type="text"
                    placeholder="(auto slug)"
                    value={names[c.name] ?? ""}
                    onChange={(e) => setNames({ ...names, [c.name]: e.target.value })}
                    style={{ width: 160 }}
                  />
                </td>
                <td>
                  <button
                    className="primary"
                    disabled={!!busy}
                    onClick={() =>
                      wrap(c.name, () =>
                        api.post("/worlds/import", {
                          sourceName: c.name,
                          targetName: names[c.name] || undefined,
                        }),
                      )
                    }
                  >
                    {busy === c.name ? "Copying…" : "Import"}
                  </button>
                </td>
              </tr>
            ))}
            {cands.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No single-player saves found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
