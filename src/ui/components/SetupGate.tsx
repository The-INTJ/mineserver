import { useState } from "react";
import type { Job, SetupState } from "../../shared/types.ts";
import { api, errMsg, pollJob } from "../api.ts";

export function setupReady(setup: SetupState): boolean {
  return setup.runtime.installed && setup.runtime.javaOk && setup.eulaAccepted;
}

/** Per-runtime checklist: Java, EULA, runtime install. Renders nothing once all three are green. */
export function SetupGate({ setup, onChange }: { setup: SetupState; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [job, setJob] = useState<Job | null>(null);

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

  if (setupReady(setup)) return null;
  const rt = setup.runtime;

  return (
    <div className="card">
      <h2>
        Setup for runtime <span className="mono">{rt.id}</span>
      </h2>
      {!rt.javaOk && (
        <p className="notice bad">
          Needs Java {rt.javaMajor}
          {rt.loader !== "fabric" ? " exactly" : " or newer"}; found {rt.javaVersion ?? "nothing"}
          {rt.javaPath ? ` at ${rt.javaPath}` : ""}. Install that JDK (Adoptium or Oracle) into{" "}
          <code>C:\Program Files\Java</code> or set <code>MINESERVER_JAVA_{rt.javaMajor}</code>.{" "}
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
      {!rt.installed && (
        <div className="notice">
          Runtime <b>{rt.loader}</b> {rt.minecraft} (loader {rt.loaderVersion}) is not installed.
          {rt.loader === "fabric"
            ? " Downloads the ~180 KB Fabric launcher; it fetches the vanilla server on first start."
            : " Downloads the installer and runs it (a few minutes, pulls ~100 libraries)."}{" "}
          <button
            className="primary"
            disabled={!!busy || !rt.javaOk}
            onClick={() =>
              run("install", async () => {
                const j = await api.post<Job>("/runtimes/install", {
                  runtime: {
                    loader: rt.loader,
                    minecraft: rt.minecraft,
                    loaderVersion: rt.loaderVersion,
                  },
                });
                await pollJob(j.id, setJob);
              })
            }
          >
            {busy === "install" ? "Installing…" : `Install ${rt.id}`}
          </button>
          {job && busy === "install" && (
            <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
              {job.message}
            </div>
          )}
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
