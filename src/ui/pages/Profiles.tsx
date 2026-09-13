import { useCallback, useEffect, useState } from "react";
import type {
  ModInLibraryWithState,
  Profile,
  StatusResponse,
  WorldInfo,
} from "../../shared/types.ts";
import { api, errMsg } from "../api.ts";
import { EnvBadge } from "../components/StatusBadge.tsx";

export function Profiles({ status, refresh }: { status: StatusResponse; refresh: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mods, setMods] = useState<ModInLibraryWithState[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newWorld, setNewWorld] = useState("");
  const [props, setProps] = useState("");
  const [mem, setMem] = useState(4);

  const active = status.server.activeProfileId;
  const running = status.server.status !== "stopped" && status.server.status !== "crashed";

  const load = useCallback(async () => {
    try {
      const [p, w] = await Promise.all([
        api.get<{ profiles: Profile[] }>("/profiles"),
        api.get<{ worlds: WorldInfo[] }>("/worlds"),
      ]);
      setProfiles(p.profiles);
      setWorlds(w.worlds);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const sel = profiles.find((p) => p.id === selected) ?? null;
  useEffect(() => {
    if (!selected) return;
    void api
      .get<{ mods: ModInLibraryWithState[] }>(`/mods?profileId=${encodeURIComponent(selected)}`)
      .then((r) => setMods(r.mods));
    const p = profiles.find((x) => x.id === selected);
    if (p) {
      setProps(
        Object.entries(p.properties)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      );
      setMem(p.jvm.maxMemoryGb);
    }
  }, [selected, profiles]);

  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      refresh();
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const toggle = (file: string, enabled: boolean) =>
    wrap(async () => {
      await api.post(`/profiles/${selected}/mods`, { file, enabled });
      setMods((m) => m.map((x) => (x.file === file ? { ...x, enabled } : x)));
    });

  const saveSettings = () =>
    wrap(async () => {
      const properties: Record<string, string> = {};
      for (const line of props.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i > 0) properties[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      await api.put(`/profiles/${selected}`, {
        properties,
        jvm: { maxMemoryGb: mem, extraArgs: sel?.jvm.extraArgs ?? [] },
      });
    });

  return (
    <div className="grid-2">
      <div className="card">
        <h2>Profiles</h2>
        {running && (
          <p className="notice">
            Server is {status.server.status}: switching profiles is disabled until it stops.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>World</th>
              <th>Mods</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} className={p.id === active ? "active" : ""}>
                <td>
                  <a href="#" onClick={(e) => (e.preventDefault(), setSelected(p.id))}>
                    {p.name}
                  </a>
                  {p.id === active && (
                    <span className="badge running" style={{ marginLeft: 6 }}>
                      active
                    </span>
                  )}
                </td>
                <td className="mono">{p.world}</td>
                <td>{p.enabledMods.length}</td>
                <td className="row">
                  <button
                    disabled={running || p.id === active}
                    onClick={() => wrap(() => api.post(`/profiles/${p.id}/activate`))}
                  >
                    Activate
                  </button>
                  <button
                    className="danger"
                    disabled={running && p.id === active}
                    onClick={() =>
                      confirm(`Delete profile ${p.name}?`) &&
                      wrap(() => api.del(`/profiles/${p.id}`))
                    }
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 style={{ marginTop: 16 }}>New profile</h2>
        <div className="row">
          <input
            type="text"
            placeholder="name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <select value={newWorld} onChange={(e) => setNewWorld(e.target.value)}>
            <option value="">(new world, same name)</option>
            {worlds.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            className="primary"
            disabled={!newName.trim()}
            onClick={() =>
              wrap(async () => {
                const p = await api.post<Profile>("/profiles", {
                  name: newName.trim(),
                  world: newWorld || undefined,
                });
                setNewName("");
                setSelected(p.id);
              })
            }
          >
            Create
          </button>
        </div>
        {err && <p className="error">{err}</p>}
      </div>

      <div className="card">
        {!sel ? (
          <p className="muted">Select a profile to edit its mods and settings.</p>
        ) : (
          <>
            <h2>
              {sel.name} <span className="muted mono">{sel.id}</span>
            </h2>
            <h3 style={{ fontSize: 14 }}>Mods ({mods.filter((m) => m.enabled).length} enabled)</h3>
            {mods.length === 0 && (
              <p className="muted">Library is empty. Add jars on the Mods tab.</p>
            )}
            <div style={{ maxHeight: 360, overflow: "auto" }}>
              {mods.map((m) => (
                <label key={m.file} className="check">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={(e) => toggle(m.file, e.target.checked)}
                  />
                  <span>
                    {m.name} <span className="muted">{m.version}</span>
                  </span>
                  <EnvBadge env={m.environment} />
                  {m.parseError && (
                    <span className="warn" title={m.parseError}>
                      ⚠
                    </span>
                  )}
                </label>
              ))}
            </div>
            <h3 style={{ fontSize: 14, marginTop: 14 }}>Settings</h3>
            <div className="row">
              <label>
                Max memory (GB){" "}
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={mem}
                  onChange={(e) => setMem(Number(e.target.value))}
                  style={{ width: 70 }}
                />
              </label>
            </div>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              server.properties overrides (key=value per line). <code>level-name</code> and{" "}
              <code>white-list</code> are always forced.
            </p>
            <textarea
              value={props}
              onChange={(e) => setProps(e.target.value)}
              placeholder={"motd=Our server\nmax-players=10\ndifficulty=hard"}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="primary"
                onClick={saveSettings}
                disabled={running && sel.id === active}
              >
                Save settings
              </button>
              {running && sel.id === active && (
                <span className="muted">
                  mod toggles apply on next start; settings locked while running
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
