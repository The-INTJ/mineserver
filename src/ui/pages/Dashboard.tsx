import { useState } from "react";
import type { StatusResponse } from "../../shared/types.ts";
import { api, errMsg, useLogStream } from "../api.ts";
import { EulaGate } from "../components/EulaGate.tsx";
import { LogView } from "../components/LogView.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";

export function Dashboard({ status, refresh }: { status: StatusResponse; refresh: () => void }) {
  const lines = useLogStream(() => refresh());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const [wl, setWl] = useState("");

  const s = status.server;
  const active = s.status === "starting" || s.status === "running" || s.status === "stopping";
  const ready = status.setup.javaOk && status.setup.eulaAccepted && status.setup.launcherJarPresent;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const c = cmd.trim();
    if (!c) return;
    setCmd("");
    void act(() => api.post("/server/command", { command: c }));
  };

  return (
    <>
      <EulaGate setup={status.setup} onChange={refresh} />
      <div className="grid-2">
        <div className="card">
          <h2>
            Server <StatusBadge status={s.status} />
          </h2>
          <dl className="kv">
            <dt>Profile</dt>
            <dd>
              {status.activeProfile
                ? `${status.activeProfile.name} (${status.activeProfile.id})`
                : "—"}
            </dd>
            <dt>World</dt>
            <dd>{status.activeProfile?.world ?? "—"}</dd>
            <dt>Mods</dt>
            <dd>{status.activeProfile?.enabledMods.length ?? 0} enabled</dd>
            <dt>Players</dt>
            <dd>{s.players.length ? s.players.join(", ") : "none"}</dd>
            <dt>LAN address</dt>
            <dd>{status.lan.ip ? `${status.lan.ip}:${status.lan.port}` : "unknown"}</dd>
            <dt>Public address</dt>
            <dd>
              {status.tunnel.publicAddress ?? (
                <span className="muted">no tunnel ({status.tunnel.mode})</span>
              )}
            </dd>
            <dt>Last stop</dt>
            <dd>{s.lastStopReason ?? "—"}</dd>
          </dl>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              disabled={busy || active || !ready}
              onClick={() => act(() => api.post("/server/start"))}
            >
              Start
            </button>
            <button disabled={busy || !active} onClick={() => act(() => api.post("/server/stop"))}>
              Stop
            </button>
            <button
              disabled={busy || !active}
              onClick={() => act(() => api.post("/server/restart"))}
            >
              Restart
            </button>
          </div>
          {err && <p className="error">{err}</p>}
          <div className="row" style={{ marginTop: 14 }}>
            <input
              type="text"
              placeholder="Minecraft username"
              value={wl}
              onChange={(e) => setWl(e.target.value)}
              disabled={s.status !== "running"}
            />
            <button
              disabled={busy || s.status !== "running" || !wl.trim()}
              onClick={() => {
                const n = wl.trim();
                setWl("");
                void act(() => api.post("/server/whitelist", { name: n }));
              }}
            >
              Whitelist add
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Java {status.setup.javaVersion ?? "?"} · Minecraft {status.versions.minecraft} · Fabric{" "}
            {status.versions.loader} · data <span className="mono">{status.setup.dataDir}</span>
          </p>
        </div>
        <div className="card">
          <h2>Console</h2>
          <LogView lines={lines} />
          <div className="console">
            <input
              type="text"
              placeholder={
                s.status === "running"
                  ? "command (e.g. list, say hi, whitelist add Name)"
                  : "server not running"
              }
              value={cmd}
              disabled={s.status !== "running" && s.status !== "starting"}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
            />
            <button
              disabled={busy || (s.status !== "running" && s.status !== "starting")}
              onClick={send}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
