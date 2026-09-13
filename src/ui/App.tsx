import { useState } from "react";
import { useStatus } from "./api.ts";
import { StatusBadge } from "./components/StatusBadge.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Export } from "./pages/Export.tsx";
import { Mods } from "./pages/Mods.tsx";
import { Profiles } from "./pages/Profiles.tsx";
import { Tunnel } from "./pages/Tunnel.tsx";
import { Worlds } from "./pages/Worlds.tsx";

const TABS = ["Dashboard", "Profiles", "Mods", "Worlds", "Tunnel", "Export"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("Dashboard");
  const { status, error, refresh } = useStatus();

  return (
    <>
      <header className="top">
        <h1>⛏ mineserver</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {status && (
          <span className="row">
            <StatusBadge status={status.server.status} />
            {status.server.players.length > 0 && (
              <span className="muted">{status.server.players.length} online</span>
            )}
          </span>
        )}
      </header>
      <main>
        {error && (
          <p className="notice bad">Daemon unreachable: {error}. Is `npm run dev` running?</p>
        )}
        {!status && !error && <p className="muted">Connecting…</p>}
        {status && tab === "Dashboard" && <Dashboard status={status} refresh={refresh} />}
        {status && tab === "Profiles" && <Profiles status={status} refresh={refresh} />}
        {status && tab === "Mods" && <Mods status={status} />}
        {status && tab === "Worlds" && <Worlds status={status} />}
        {status && tab === "Tunnel" && <Tunnel refresh={refresh} />}
        {status && tab === "Export" && <Export status={status} />}
      </main>
    </>
  );
}
