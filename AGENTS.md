# AGENTS.md — operating mineserver as an AI agent

Read `CLAUDE.md` first for architecture. This file is the runbook: where state lives, what the API
does, and how to diagnose the common failures.

## Data layout (`data/`, git-ignored)

```
data/
  state.json                 { activeProfileId, lastStartedAt, eulaAccepted }
  profiles/<id>.json         Profile: runtime{loader,minecraft,loaderVersion}, world, enabledMods[],
                             clientMods[], properties{}, jvm{maxMemoryGb, extraArgs[]}, modpack?
  mods/library/*.jar         every jar, once, any loader/version
  mods/library.json          cached manifest metadata per jar (id, version, loader, environment)
  modpacks/*.mrpack          imported packs (kept: the export zip ships them to friends)
  worlds/<name>/             worlds; a world belongs to the Minecraft version that created it
  servers/<loader>-<mc>/     one server working dir PER RUNTIME, e.g. fabric-26.2/, forge-1.20.1/
    fabric-server-launch.jar | libraries/net/minecraftforge/forge/<v>/win_args.txt   (install marker)
    eula.txt                 mirrored from state.json's one-time acceptance
    server.properties        REGENERATED on every start (template + profile overrides + forced keys)
    mods/                    REBUILT on every start (hardlinks into ../../mods/library)
    world -> ../../worlds/<x>   directory junction, re-pointed on every start
    config/, kubejs/, ...    modpack overrides land here
    logs/latest.log, crash-reports/, whitelist.json, ops.json, usercache.json   the game's own
  logs/server-<ts>.log       daemon capture of stdout/stderr, one per launch, last 30 kept
  playit/                    agent binary + secret (never log/commit) + tunnel.json
  exports/*.zip              client packs
  client-sync-manifest.json  jars mineserver placed into .minecraft/mods (only those are ever removed)
```

Runtime id = `<loader>-<minecraft>`. Switching loaders is just activating a profile whose runtime
differs; the daemon picks the right JDK (25 for 26.x, 17 for 1.20.1, 21 for 1.21.x) from
`C:\Program Files\Java\jdk-*` and refuses to start Forge/NeoForge on a different major.

## HTTP API (`http://127.0.0.1:3400/api`)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | ServerState + active profile + setup (for the active profile's runtime) + LAN + tunnel + all runtimes |
| POST | `/server/start` `{profileId?}` | 409 `SERVER_RUNNING` / `RUNTIME_MISSING` / `EULA_REQUIRED` / `JAVA_UNSUPPORTED` |
| POST | `/server/stop` · `/server/restart` | stop = `stop` on stdin, 60 s, then `taskkill /T /F` |
| POST | `/server/command` `{command}` · `/server/whitelist` `{name}` | stdin; 409 `SERVER_NOT_RUNNING` |
| GET | `/logs?lines=&grep=` · `/logs/stream` (SSE) · `/logs/files` · `/logs/files/:source/:name` | source = daemon \| server \| crash (server/crash = focused runtime) |
| GET/POST | `/setup` · `/setup/eula {accepted:true}` · `/setup/recheck-java` | |
| GET/POST | `/runtimes` · `/runtimes/:id` · `/runtimes/install {runtime}` | install returns a **job** (202) |
| GET/POST | `/modpacks` · `/modpacks/import {source, profileName?, world?, maxMemoryGb?}` (or multipart `file`) | returns a **job**; source = Modrinth URL/slug or .mrpack URL |
| GET | `/jobs` · `/jobs/:id` | `{status: running\|done\|error, message, progress, result, error}` |
| GET/POST/DELETE | `/mods?profileId=` · `/mods` (multipart `files`) · `/mods/import-client` · `/mods/:file` | DELETE 409 `MOD_IN_USE` if enabled in the running profile |
| CRUD | `/profiles` · `/profiles/:id` · `/profiles/:id/activate` · `/profiles/:id/mods {file, enabled, side?}` | side = server (default) \| client; activate 409 while running |
| GET/POST/DELETE | `/worlds` · `/worlds/import/candidates` · `/worlds/import {sourceName,targetName?}` · `/worlds/:name` | import copies, never links |
| POST/GET | `/export/client-zip {profileId?}` · `/export/list` · `/export/download/:file` · `/export/sync-client` | modpack profiles: zip includes the .mrpack; sync refused |
| GET/POST | `/tunnel` · `/tunnel/mode {mode,address?}` · `/tunnel/install` · `/tunnel/claim/start` · `/tunnel/claim/status` · `/tunnel/start` · `/tunnel/stop` | |
| GET | `/debug/snapshot` · `/debug/paths` | start here when something is wrong |

Errors: `{ error, code }` with the HTTP status. Codes are stable.

## MCP tools

Read: `status`, `tail_logs`, `list_profiles`, `list_runtimes`, `list_mods`, `get_players`,
`list_worlds`, `tunnel_status`, `job_status`, `list_log_files`, `read_log_file`,
`recent_crash_report`, `debug_snapshot`.
Action: `start_server`, `stop_server`, `restart_server`, `send_command`, `set_mod_enabled`,
`switch_profile`, `create_profile`, `install_runtime`, `import_modpack`, `import_world`,
`export_client_zip`, `import_client_mods`.

The daemon must be running (`npm run play` or `npm run dev`). `MINESERVER_URL` overrides the base URL.

## Diagnosis playbook

1. `debug_snapshot` (or `GET /api/debug/snapshot`). Look at `status.server.status`,
   `status.server.lastStopReason`, `status.setup.runtime`, `recentLogs`, `latestCrashReport`, `jobs`.
2. **Won't start, status stays `stopped`** → `status.setup.runtime`: `installed`, `javaOk`
   (which major it wanted vs found), `eulaAccepted`.
3. **Exits immediately** → `lastStopReason`. "EULA" means eula.txt; otherwise read `recentLogs` for
   `Mixin` / `Incompatible mods` / `Missing or unsupported mandatory dependencies` — a jar for
   another loader or version. `list_mods` shows each jar's loader; the profile should only enable
   compatible ones (incompatible ones are skipped with a log note anyway).
4. **Crashed after Done** → `recent_crash_report`; the first "Caused by" names the mod.
5. **Modpack import failed** → `job_status`: the message names the step (resolve, download,
   runtime install, mods N/M, overrides). Re-running is safe; downloads resume from the library.
6. **Friend can't connect** → `tunnel_status`: `publicAddress` set and `status` running; then
   confirm their name is whitelisted (`send_command "whitelist list"`). Whitelists are per runtime
   dir: switching Fabric ↔ Forge means re-adding names once.
7. **LAN player can't connect** → Windows Firewall prompt for that runtime's java.exe was declined
   (JDK 17 and JDK 25 are different executables, each prompts once).
8. **Mods "missing" in game** → `serverModsDir` in the snapshot vs `activeProfile.enabledMods`.

## Rules for agents

- Do not start or stop the server while players are online without being asked.
- Never read or print `data/playit/playit.toml`.
- Do not delete worlds. Ever. Ask.
- Never point a profile at a world created by a different Minecraft version.
- Toggling mods is safe at any time (it only affects the next start).
