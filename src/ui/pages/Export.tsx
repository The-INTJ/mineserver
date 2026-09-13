import { useCallback, useEffect, useState } from "react";
import type {
  ClientSyncResult,
  ExportResult,
  Profile,
  StatusResponse,
} from "../../shared/types.ts";
import { api, errMsg, fmtBytes } from "../api.ts";

interface ExportFile {
  file: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function Export({ status }: { status: StatusResponse }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [last, setLast] = useState<ExportResult | null>(null);
  const [sync, setSync] = useState<ClientSyncResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, f] = await Promise.all([
        api.get<{ profiles: Profile[] }>("/profiles"),
        api.get<{ files: ExportFile[] }>("/export/list"),
      ]);
      setProfiles(p.profiles);
      setFiles(f.files);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!profileId && status.server.activeProfileId) setProfileId(status.server.activeProfileId);
  }, [status.server.activeProfileId, profileId]);

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
        <h2>Client pack for friends</h2>
        <p className="muted">
          Zips the profile's mods minus server-only ones, plus a README with install steps and the
          public address if a tunnel is up. Send the zip to John.
        </p>
        <div className="row">
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.enabledMods.length} mods)
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={!!busy || !profileId}
            onClick={() =>
              wrap("zip", async () =>
                setLast(await api.post<ExportResult>("/export/client-zip", { profileId })),
              )
            }
          >
            {busy === "zip" ? "Zipping…" : "Export zip"}
          </button>
        </div>
        {last && (
          <p className="notice ok">
            Built <a href={`/api/export/download/${encodeURIComponent(last.file)}`}>{last.file}</a>{" "}
            ({fmtBytes(last.sizeBytes)}): {last.includedMods.length} mods
            {last.excludedServerOnly.length > 0 && (
              <>, excluded server-only: {last.excludedServerOnly.join(", ")}</>
            )}
          </p>
        )}
        <h3 style={{ fontSize: 14 }}>Previous exports</h3>
        <table>
          <tbody>
            {files.map((f) => (
              <tr key={f.file}>
                <td>
                  <a href={`/api/export/download/${encodeURIComponent(f.file)}`}>{f.file}</a>
                </td>
                <td>{fmtBytes(f.sizeBytes)}</td>
                <td className="muted">{f.modifiedAt.slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
            {files.length === 0 && (
              <tr>
                <td className="muted">none yet</td>
              </tr>
            )}
          </tbody>
        </table>
        {err && <p className="error">{err}</p>}
      </div>
      <div className="card">
        <h2>Sync my client</h2>
        <p className="muted">
          Copies the same set into <span className="mono">{status.setup.minecraftDir}\mods</span>.
          Only jars mineserver placed earlier are ever removed; your own extras (Sodium, zoom) are
          left alone. Close Minecraft first.
        </p>
        <button
          disabled={!!busy || !profileId || !status.setup.minecraftDirPresent}
          onClick={() =>
            wrap("sync", async () =>
              setSync(await api.post<ClientSyncResult>("/export/sync-client", { profileId })),
            )
          }
        >
          {busy === "sync" ? "Copying…" : "Sync client mods"}
        </button>
        {sync && (
          <p className="notice ok">
            Copied {sync.copied.length}, removed {sync.removed.length} into{" "}
            <span className="mono">{sync.targetDir}</span>.
          </p>
        )}
      </div>
    </div>
  );
}
