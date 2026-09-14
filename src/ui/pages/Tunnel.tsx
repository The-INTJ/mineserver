import { useCallback, useEffect, useState } from "react";
import type { TunnelMode, TunnelState } from "../../shared/types.ts";
import { api, errMsg, fmtBytes } from "../api.ts";
import { StatusBadge } from "../components/StatusBadge.tsx";

type TunnelInfo = TunnelState & { install: { version: string; url: string; sizeBytes: number } };

export function Tunnel({ refresh }: { refresh: () => void }) {
  const [t, setT] = useState<TunnelInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addr, setAddr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.get<TunnelInfo>("/tunnel");
      setT(r);
      if (r.mode === "external" && r.publicAddress) setAddr((prev) => prev || r.publicAddress!);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 3000);
    return () => clearInterval(i);
  }, [load]);

  const wrap = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await load();
      refresh();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (!t) return <div className="card">Loading…</div>;
  const setMode = (mode: TunnelMode) =>
    wrap("mode", () =>
      api.post("/tunnel/mode", { mode, address: mode === "external" ? addr : undefined }),
    );

  return (
    <div className="grid-2">
      <div className="card">
        <h2>
          Remote access <StatusBadge status={t.status} />
        </h2>
        <p className="muted">
          Only the game port (25565) is ever exposed. This management UI stays on localhost. Whoever
          has the public address can reach the server, so keep the whitelist on (it is, always).
        </p>
        <div className="row">
          {(["off", "playit", "external"] as TunnelMode[]).map((m) => (
            <label key={m} className="check">
              <input
                type="radio"
                name="mode"
                checked={t.mode === m}
                onChange={() => setMode(m)}
                disabled={!!busy}
              />
              {m === "off"
                ? "Off (LAN only)"
                : m === "playit"
                  ? "playit.gg (managed)"
                  : "External (I run my own tunnel)"}
            </label>
          ))}
        </div>
        {t.publicAddress && (
          <p className="notice ok">
            Give remote players: <b className="mono">{t.publicAddress}</b>{" "}
            <button onClick={() => void navigator.clipboard.writeText(t.publicAddress!)}>
              Copy
            </button>
          </p>
        )}
        {t.error && <p className="notice bad">{t.error}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      <div className="card">
        {t.mode === "external" && (
          <>
            <h2>External address</h2>
            <p className="muted">
              Paste whatever your tunnel (playit, ngrok, port-forward) gives you. Keep that separate
              app running. A saved address is configured; mineserver cannot verify that external
              connection from here.
            </p>
            <div className="row">
              <input
                type="text"
                placeholder="host:port"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                style={{ minWidth: 260 }}
              />
              <button className="primary" disabled={!!busy} onClick={() => setMode("external")}>
                Save
              </button>
            </div>
          </>
        )}
        {t.mode === "playit" && (
          <>
            <h2>playit.gg</h2>
            <ol style={{ paddingLeft: 18, lineHeight: 2 }}>
              <li>
                Agent{" "}
                {t.binaryPresent ? (
                  <span className="badge running">installed</span>
                ) : (
                  <span className="badge">not installed</span>
                )}
                {!t.binaryPresent && (
                  <div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Downloads {t.install.url} ({fmtBytes(t.install.sizeBytes)}) into data/playit.
                    </div>
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() => wrap("install", () => api.post("/tunnel/install"))}
                    >
                      {busy === "install" ? "Downloading…" : `Download playit ${t.install.version}`}
                    </button>
                  </div>
                )}
              </li>
              <li>
                Claim{" "}
                {t.secretPresent ? (
                  <span className="badge running">claimed</span>
                ) : (
                  <span className="badge">needs a free playit account</span>
                )}
                {!t.secretPresent && t.binaryPresent && !t.claim && (
                  <div>
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() => wrap("claim", () => api.post("/tunnel/claim/start"))}
                    >
                      Start claim
                    </button>
                  </div>
                )}
                {!t.secretPresent && t.claim && (
                  <div className="notice">
                    Open{" "}
                    <a href={t.claim.url} target="_blank" rel="noreferrer">
                      {t.claim.url}
                    </a>{" "}
                    in your browser, sign in to playit.gg and approve the agent. This page will
                    update on its own.
                  </div>
                )}
              </li>
              <li>
                Run{" "}
                {t.status === "running" ? (
                  <button
                    disabled={!!busy}
                    onClick={() => wrap("stop", () => api.post("/tunnel/stop"))}
                  >
                    Stop agent
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={!!busy || !t.secretPresent}
                    onClick={() => wrap("start", () => api.post("/tunnel/start"))}
                  >
                    {busy === "start" ? "Starting…" : "Start agent"}
                  </button>
                )}
                {t.tunnelId && (
                  <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
                    tunnel {t.tunnelId}
                  </span>
                )}
              </li>
            </ol>
            <p className="muted">
              Agent output appears in the Dashboard console prefixed with [playit].
            </p>
          </>
        )}
        {t.mode === "off" && (
          <p className="muted">LAN only. Adaline connects to the LAN address on the Dashboard.</p>
        )}
      </div>
    </div>
  );
}
