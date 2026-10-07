import { useState } from "react";
import type { StatusResponse } from "../../shared/types.ts";
import { api, errMsg, useLogStream } from "../api.ts";
import { LogView } from "../components/LogView.tsx";
import { SetupGate, setupReady } from "../components/SetupGate.tsx";
import { StatusBadge } from "../components/StatusBadge.tsx";

export function Dashboard({ status, refresh }: { status: StatusResponse; refresh: () => void }) {
  const lines = useLogStream(() => refresh());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const [wl, setWl] = useState("");

  const s = status.server;
  const active = s.status === "starting" || s.status === "running" || s.status === "stopping";
  const ready = setupReady(status.setup);
  const p = status.activeProfile;

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
      <SetupGate setup={status.setup} onChange={refresh} />
      <div className="grid-2">
        <div className="card">
          <h2>
            Server <StatusBadge status={s.status} />
          </h2>
          <dl className="kv">
            <dt>Profile</dt>
            <dd>{p ? `${p.name} (${p.id})` : "— pick one on the Profiles tab"}</dd>
            <dt>Runtime</dt>
            <dd>
              {p
                ? `${p.runtime.loader} ${p.runtime.minecraft} (${p.runtime.loaderVersion})`
                : status.setup.runtime.id}
            </dd>
            <dt>World</dt>
            <dd>{p?.world ?? "—"}</dd>
            <dt>Mods</dt>
            <dd>
              {p?.enabledMods.length ?? 0} enabled
              {p?.modpack ? ` · modpack ${p.modpack.name} ${p.modpack.version}` : ""}
            </dd>
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
          <p className="muted">
            Stop saves players and all dimensions before exiting. If saving stalls, the server
            allows 60 seconds before a forced stop.
          </p>
          <button
            disabled={busy || s.status !== "running"}
            onClick={() => act(() => api.post("/server/save"))}
          >
            Save now
          </button>{" "}
          <button
            disabled={
              busy ||
              s.status !== "running" ||
              !!status.worldBackup?.busy ||
              !!status.worldBackup?.skippedReason
            }
            onClick={() => act(() => api.post("/server/backup"))}
          >
            Back up now
          </button>
          {status.reliability && (
            <dl className="kv">
              <dt>Last confirmed save</dt>
              <dd>
                {status.reliability.run?.saveConfirmedAt
                  ? new Date(status.reliability.run.saveConfirmedAt).toLocaleString()
                  : "No save confirmation recorded yet"}
              </dd>
              <dt>Automatic recovery</dt>
              <dd>
                {status.reliability.recovery.enabled
                  ? "Enabled (maximum 3 attempts / 15 minutes)"
                  : "Disabled"}
              </dd>
              <dt>Recovery status</dt>
              <dd>
                {status.reliability.recovery.blockedReason ??
                  (status.reliability.recovery.nextAttemptAt
                    ? `Retry at ${new Date(status.reliability.recovery.nextAttemptAt).toLocaleTimeString()}`
                    : "No retry pending")}
              </dd>
              <dt>Lag warnings this run</dt>
              <dd>
                {status.reliability.run?.lagWarnings ?? 0} · worst{" "}
                {status.reliability.run?.worstLagMs ?? 0} ms
              </dd>
            </dl>
          )}
          {status.reliability?.loggingError && (
            <p className="notice bad">{status.reliability.loggingError}</p>
          )}
          {status.backups && (
            <dl className="kv">
              <dt>Backup mirror</dt>
              <dd>
                {status.backups.enabled
                  ? `${status.backups.copies} verified copies`
                  : "Not configured"}
              </dd>
              <dt>Newest world backup</dt>
              <dd>
                {status.backups.lastBackupAt
                  ? new Date(status.backups.lastBackupAt).toLocaleString()
                  : "None observed"}
              </dd>
              <dt>Last mirror success</dt>
              <dd>
                {status.backups.lastSuccessAt
                  ? new Date(status.backups.lastSuccessAt).toLocaleString()
                  : "None recorded"}
              </dd>
              {status.worldBackup && (
                <>
                  <dt>World backups</dt>
                  <dd>
                    {status.worldBackup.skippedReason ??
                      (status.worldBackup.enabled
                        ? `Every ${status.worldBackup.intervalMinutes} min while players are online` +
                          (status.worldBackup.busy ? " · backing up now" : "")
                        : "Disabled in reliability.json")}
                  </dd>
                </>
              )}
              <dt>Restore test</dt>
              <dd>
                {status.backups.restoreVerifiedAt
                  ? new Date(status.backups.restoreVerifiedAt).toLocaleString()
                  : "Not yet verified"}
              </dd>
            </dl>
          )}
          {status.worldBackup?.lastError && (
            <p className="notice bad">World backup: {status.worldBackup.lastError}</p>
          )}
          {status.backups?.lastError && (
            <p className="notice bad">Backup mirror: {status.backups.lastError}</p>
          )}
          {status.tunnel.mode === "external" && (
            <p className="notice">
              Remote access uses a separate tunnel app or port forward. Keep that connection
              running; its saved address is not a live connection check.
            </p>
          )}
          {status.backups?.enabled &&
            s.status === "running" &&
            s.players.length > 0 &&
            s.readyAt &&
            Date.now() -
              Math.max(
                Date.parse(s.readyAt),
                Date.parse(status.backups.lastBackupAt ?? "1970-01-01"),
              ) >
              45 * 60000 && (
              <p className="notice bad">
                No completed world backup in over 45 minutes while players are online. Check the
                backup errors above and free disk space.
              </p>
            )}
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
            Java {status.setup.runtime.javaVersion ?? "?"} · data{" "}
            <span className="mono">{status.setup.dataDir}</span>
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
