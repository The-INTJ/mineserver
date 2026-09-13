import { useCallback, useEffect, useState } from "react";
import type {
  ModInLibraryWithState,
  Profile,
  Runtime,
  StatusResponse,
  WorldInfo,
} from "../../shared/types.ts";
import { RUNTIME_PRESETS } from "../../shared/constants.ts";
import { api, errMsg } from "../api.ts";
import { EnvBadge, LoaderBadge } from "../components/StatusBadge.tsx";

export function Profiles({ status, refresh }: { status: StatusResponse; refresh: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mods, setMods] = useState<ModInLibraryWithState[]>([]);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newWorld, setNewWorld] = useState("");
  const [preset, setPreset] = useState(0);
  const [custom, setCustom] = useState<Runtime>({
    loader: "fabric",
    minecraft: "",
    loaderVersion: "",
  });
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

  const toggle = (file: string, enabled: boolean, side: "server" | "client") =>
    wrap(async () => {
      await api.post(`/profiles/${selected}/mods`, { file, enabled, side });
      setMods((m) =>
        m.map((x) =>
          x.file === file ? { ...x, [side === "server" ? "enabled" : "clientOnly"]: enabled } : x,
        ),
      );
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

  const runtimeForCreate = (): Runtime | undefined =>
    preset === RUNTIME_PRESETS.length ? custom : RUNTIME_PRESETS[preset].runtime;
  const visibleMods = mods.filter(
    (m) => !filter || `${m.name} ${m.id} ${m.file}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="grid-2">
      <div className="card">
        <h2>Profiles</h2>
        <p className="muted">
          A profile is a runtime (Fabric/Forge + Minecraft version), a world, and a mod set.
          Activate one, then Start on the Dashboard. Switching runtimes is just activating a profile
          that uses another one.
        </p>
        {running && (
          <p className="notice">
            Server is {status.server.status}: switching profiles is disabled until it stops.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Runtime</th>
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
                  {p.modpack && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      pack: {p.modpack.name} {p.modpack.version}
                    </div>
                  )}
                </td>
                <td>
                  <LoaderBadge loader={p.runtime.loader} />{" "}
                  <span className="mono">{p.runtime.minecraft}</span>
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
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {RUNTIME_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
            <option value={RUNTIME_PRESETS.length}>Custom runtime…</option>
          </select>
          <select value={newWorld} onChange={(e) => setNewWorld(e.target.value)}>
            <option value="">(new world, same name)</option>
            {worlds.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        {preset === RUNTIME_PRESETS.length && (
          <div className="row" style={{ marginTop: 8 }}>
            <select
              value={custom.loader}
              onChange={(e) =>
                setCustom({ ...custom, loader: e.target.value as Runtime["loader"] })
              }
            >
              <option value="fabric">fabric</option>
              <option value="forge">forge</option>
              <option value="neoforge">neoforge</option>
            </select>
            <input
              type="text"
              placeholder="minecraft (1.20.1)"
              value={custom.minecraft}
              onChange={(e) => setCustom({ ...custom, minecraft: e.target.value })}
              style={{ width: 140 }}
            />
            <input
              type="text"
              placeholder="loader version (47.4.0)"
              value={custom.loaderVersion}
              onChange={(e) => setCustom({ ...custom, loaderVersion: e.target.value })}
              style={{ width: 160 }}
            />
          </div>
        )}
        {preset < RUNTIME_PRESETS.length && RUNTIME_PRESETS[preset].note && (
          <p className="muted">{RUNTIME_PRESETS[preset].note}</p>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="primary"
            disabled={!newName.trim()}
            onClick={() =>
              wrap(async () => {
                const p = await api.post<Profile>("/profiles", {
                  name: newName.trim(),
                  world: newWorld || undefined,
                  runtime: runtimeForCreate(),
                });
                setNewName("");
                setSelected(p.id);
              })
            }
          >
            Create
          </button>
          <span className="muted">
            A world belongs to the Minecraft version that made it; don't reuse a 26.2 world on
            1.20.1.
          </span>
        </div>
        {err && <p className="error">{err}</p>}
      </div>

      <div className="card">
        {!sel ? (
          <p className="muted">Select a profile to edit its mods and settings.</p>
        ) : (
          <>
            <h2>
              {sel.name} <span className="muted mono">{sel.id}</span>{" "}
              <LoaderBadge loader={sel.runtime.loader} />{" "}
              <span className="mono muted">{sel.runtime.minecraft}</span>
            </h2>
            <div className="row">
              <h3 style={{ fontSize: 14, margin: 0 }}>
                Mods ({mods.filter((m) => m.enabled).length} server,{" "}
                {mods.filter((m) => m.clientOnly).length} client-only)
              </h3>
              <input
                type="text"
                placeholder="filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 160 }}
              />
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              Left box: the server loads it. Right box: client-only extra shipped in the export.
              Greyed rows are built for another loader.
            </p>
            {mods.length === 0 && (
              <p className="muted">Library is empty. Add jars on the Mods tab.</p>
            )}
            <div style={{ maxHeight: 380, overflow: "auto" }}>
              {visibleMods.map((m) => (
                <label key={m.file} className="check" style={{ opacity: m.compatible ? 1 : 0.45 }}>
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={!m.compatible}
                    onChange={(e) => toggle(m.file, e.target.checked, "server")}
                    title="server loads it"
                  />
                  <input
                    type="checkbox"
                    checked={m.clientOnly}
                    onChange={(e) => toggle(m.file, e.target.checked, "client")}
                    title="client-only extra"
                  />
                  <span>
                    {m.name} <span className="muted">{m.version}</span>
                  </span>
                  <LoaderBadge loader={m.loader} />
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
