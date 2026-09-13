import { useCallback, useEffect, useState } from "react";
import type { ModInLibraryWithState, StatusResponse } from "../../shared/types.ts";
import { api, errMsg, fmtBytes } from "../api.ts";
import { EnvBadge } from "../components/StatusBadge.tsx";

export function Mods({ status }: { status: StatusResponse }) {
  const [mods, setMods] = useState<ModInLibraryWithState[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMods((await api.get<{ mods: ModInLibraryWithState[] }>("/mods")).mods);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const wrap = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      await load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Mod library</h2>
      <p className="muted">
        Every jar lives here once. Profiles pick which ones the server loads; the export zip drops
        server-only jars. Client-only jars (Sodium, Iris, Mod Menu) are harmless on the server,
        Fabric just skips them.
      </p>
      <div className="row">
        <label className="btn">
          Upload jars…
          <input
            type="file"
            accept=".jar"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = e.target.files;
              if (files?.length)
                void wrap(
                  async () =>
                    `added ${(await api.upload<{ added: unknown[] }>("/mods", files)).added.length} jar(s)`,
                );
              e.target.value = "";
            }}
          />
        </label>
        <button
          disabled={busy || !status.setup.minecraftDirPresent}
          title={status.setup.minecraftDir}
          onClick={() =>
            wrap(async () => {
              const r = await api.post<{ added: string[]; skipped: string[] }>(
                "/mods/import-client",
              );
              return `imported ${r.added.length}, skipped ${r.skipped.length} already present`;
            })
          }
        >
          Import from .minecraft/mods
        </button>
      </div>
      {msg && <p className="notice ok">{msg}</p>}
      {err && <p className="error">{err}</p>}
      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Mod</th>
            <th>Version</th>
            <th>Side</th>
            <th>File</th>
            <th>Size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {mods.map((m) => (
            <tr key={m.file}>
              <td>
                {m.name}
                {m.enabled && (
                  <span className="badge running" style={{ marginLeft: 6 }}>
                    in active profile
                  </span>
                )}
                {m.parseError && (
                  <div className="warn" style={{ fontSize: 12 }}>
                    {m.parseError}
                  </div>
                )}
              </td>
              <td className="mono">{m.version}</td>
              <td>
                <EnvBadge env={m.environment} />
              </td>
              <td className="mono">{m.file}</td>
              <td>{fmtBytes(m.sizeBytes)}</td>
              <td>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    confirm(`Remove ${m.file} from the library?`) &&
                    wrap(() => api.del(`/mods/${encodeURIComponent(m.file)}`))
                  }
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {mods.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Empty. Upload jars or import from your client.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
