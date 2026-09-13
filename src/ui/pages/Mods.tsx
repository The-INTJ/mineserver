import { useCallback, useEffect, useState } from "react";
import type {
  Job,
  ModInLibraryWithState,
  ModpackImportResult,
  StatusResponse,
} from "../../shared/types.ts";
import { api, errMsg, fmtBytes, pollJob } from "../api.ts";
import { EnvBadge, LoaderBadge } from "../components/StatusBadge.tsx";

export function Mods({ status, refresh }: { status: StatusResponse; refresh: () => void }) {
  const [mods, setMods] = useState<ModInLibraryWithState[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState("");
  const [packName, setPackName] = useState("");
  const [job, setJob] = useState<Job | null>(null);

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
      refresh();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const importPack = (body: { source?: string; file?: File }) =>
    wrap(async () => {
      const j = body.file
        ? await api.upload<Job>(
            "/modpacks/import",
            [body.file],
            "file",
            packName ? { profileName: packName } : {},
          )
        : await api.post<Job>("/modpacks/import", {
            source: body.source,
            profileName: packName || undefined,
          });
      setJob(j);
      const done = await pollJob(j.id, setJob);
      const r = done.result as ModpackImportResult;
      setSource("");
      return `Imported ${r.modpack.name} ${r.modpack.version}: profile "${r.profileId}" on ${r.runtime.id}, ${r.serverMods.length} server mods, ${r.clientMods.length} client-only, ${r.overrideFiles} config files. Activate it on the Profiles tab.`;
    });

  const visible = mods.filter(
    (m) =>
      !filter ||
      `${m.name} ${m.id} ${m.file} ${m.loader}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <div className="card">
        <h2>Import a modpack</h2>
        <p className="muted">
          Paste a Modrinth modpack URL or slug (or a direct .mrpack link), or upload a .mrpack.
          mineserver installs the pack's runtime (e.g. Forge 1.20.1), downloads the server-side jars
          into the library, applies the pack's configs, and creates a profile. Friends install the
          same pack in their launcher; the export zip includes it.
        </p>
        <div className="row">
          <input
            type="text"
            placeholder="https://modrinth.com/modpack/society-sunlit-valley"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            style={{ minWidth: 340 }}
          />
          <input
            type="text"
            placeholder="profile name (optional)"
            value={packName}
            onChange={(e) => setPackName(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || !source.trim()}
            onClick={() => importPack({ source: source.trim() })}
          >
            {busy && job ? "Importing…" : "Import"}
          </button>
          <label className="btn">
            Upload .mrpack…
            <input
              type="file"
              accept=".mrpack"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importPack({ file: f });
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {job && job.status === "running" && (
          <p className="notice">
            <b>{job.title}</b>: {job.message}
            {job.progress !== null && ` (${Math.round(job.progress * 100)}%)`}
          </p>
        )}
        {msg && <p className="notice ok">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </div>
      <div className="card">
        <h2>Mod library</h2>
        <p className="muted">
          Every jar lives here once, any loader or version. Profiles pick which ones the server
          loads; jars built for another loader are greyed out there. The export zip drops
          server-only jars.
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
          <input
            type="text"
            placeholder="filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="muted">{mods.length} jars</span>
        </div>
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Mod</th>
              <th>Version</th>
              <th>Loader</th>
              <th>Side</th>
              <th>File</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <tr key={m.file}>
                <td>
                  {m.name}
                  {m.enabled && (
                    <span className="badge running" style={{ marginLeft: 6 }}>
                      active
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
                  <LoaderBadge loader={m.loader} />
                </td>
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
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {mods.length === 0
                    ? "Empty. Upload jars, import from your client, or import a modpack."
                    : "No matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
