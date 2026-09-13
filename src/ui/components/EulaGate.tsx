import { useState } from "react";
import type { SetupState } from "../../shared/types.ts";
import { api, errMsg } from "../api.ts";

/** First-run checklist: Java, EULA, launcher jar. Renders nothing once all three are green. */
export function EulaGate({ setup, onChange }: { setup: SetupState; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  if (setup.javaOk && setup.eulaAccepted && setup.launcherJarPresent) return null;

  return (
    <div className="card">
      <h2>First-run setup</h2>
      {!setup.javaOk && (
        <p className="notice bad">
          Java 25+ not found at <code>{setup.javaPath}</code> (got {setup.javaVersion ?? "nothing"}
          ). Install JDK 25 or set <code>MINESERVER_JAVA</code>.{" "}
          <button
            disabled={!!busy}
            onClick={() => run("java", () => api.post("/setup/recheck-java"))}
          >
            Re-check
          </button>
        </p>
      )}
      {!setup.eulaAccepted && (
        <div className="notice">
          <label className="check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>
              I agree to the{" "}
              <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">
                Minecraft EULA
              </a>
            </span>
          </label>
          <button
            className="primary"
            disabled={!agree || !!busy}
            onClick={() => run("eula", () => api.post("/setup/eula", { accepted: true }))}
          >
            Accept EULA
          </button>
        </div>
      )}
      {!setup.launcherJarPresent && (
        <p className="notice">
          The Fabric server launcher (~180 KB) is not downloaded yet. It fetches the vanilla server
          on first start.{" "}
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => run("dl", () => api.post("/setup/download-launcher"))}
          >
            {busy === "dl" ? "Downloading…" : "Download launcher"}
          </button>
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
