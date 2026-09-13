# AGENTS.md — operating mineserver as an AI agent

Read `CLAUDE.md` first for architecture. This file is the runbook: where state lives, what the API
does, and how to diagnose the common failures.

## Data layout (`data/`, git-ignored)

```
data/
  state.json                 { activeProfileId, lastStartedAt, eulaAccepted }
  profiles/<id>.json         Profile (world, enabledMods[], properties{}, jvm{maxMemoryGb, extraArgs[]})
  mods/library/*.jar         every jar, once
  mods/library.json          cached fabric.mod.json metadata per jar (id, version, environment)
  worlds/<name>/             worlds; the active one is junction-linked from data/server/world
  server/                    the Fabric server's working dir
    fabric-server-launch.jar downloaded from meta.fabricmc.net (see constants.ts)
    eula.txt                 written only after the user accepts in the UI
    server.properties        REGENERATED on every start (template + profile overrides + forced keys)
    mods/                    REBUILT on every start (hardlinks into ../mods/library)
    world -> ../worlds/<x>   directory junction
    logs/latest.log          the game's own log; crash-reports/ likewise
    whitelist.json, ops.json, usercache.json   the game's; contain usernames + UUIDs
  logs/server-<ts>.log       daemon capture of stdout/stderr, one per launch, last 30 kept
  playit/playit-0.17.1.exe   agent binary (downloaded after user confirmation)
  playit/playit.toml         secret_key — never log, never commit
  playit/tunnel.json         { mode, publicAddress, tunnelId }
  exports/*.zip              client packs
  client-sync-manifest.json  jars mineserver placed into .minecraft/mods (only those are ever removed)
```

## HTTP API (`http://127.0.0.1:3400/api`)

| Method | Path | Notes |
|---|---|---|
| GET | `/status` | ServerState + active profile + setup + LAN + tunnel + versions |
| POST | `/server/start` `{profileId?}` | 409 `SERVER_RUNNING` / `EULA_REQUIRED` / `LAUNCHER_MISSING` / `JAVA_UNSUPPORTED` |
| POST | `/server/stop` · `/server/restart` | stop = `stop` on stdin, 60 s, then `taskkill /T /F` |
| POST | `/server/command` `{command}` | stdin; 409 `SERVER_NOT_RUNNING` |
| POST | `/server/whitelist` `{name}` | sends `whitelist add <name>` |
| GET | `/logs?lines=&grep=` · `/logs/stream` (SSE `log`, `state`) · `/logs/files` · `/logs/files/:source/:name` | source = daemon \| server \| crash |
| GET/POST | `/setup` · `/setup/eula {accepted:true}` · `/setup/download-launcher` · `/setup/recheck-java` | |
| GET/POST/DELETE | `/mods?profileId=` · `/mods` (multipart `files`) · `/mods/import-client` · `/mods/:file` | DELETE 409 `MOD_IN_USE` if enabled in the running profile |
| CRUD | `/profiles` · `/profiles/:id` · `/profiles/:id/activate` · `/profiles/:id/mods {file,enabled}` | activate/update 409 while that profile runs; toggles apply next start |
| GET/POST/DELETE | `/worlds` · `/worlds/import/candidates` · `/worlds/import {sourceName,targetName?}` · `/worlds/:name` | import copies, never links |
| POST/GET | `/export/client-zip {profileId?}` · `/export/list` · `/export/download/:file` · `/export/sync-client` | |
| GET/POST | `/tunnel` · `/tunnel/mode {mode,address?}` · `/tunnel/install` · `/tunnel/claim/start` · `/tunnel/claim/status` · `/tunnel/start` · `/tunnel/stop` | |
| GET | `/debug/snapshot` · `/debug/paths` | start here when something is wrong |

Errors: `{ error, code }` with the HTTP status. Codes are stable.

## MCP tools

Read: `status`, `tail_logs`, `list_profiles`, `list_mods`, `get_players`, `list_worlds`,
`tunnel_status`, `list_log_files`, `read_log_file`, `recent_crash_report`, `debug_snapshot`.
Action: `start_server`, `stop_server`, `restart_server`, `send_command`, `set_mod_enabled`,
`switch_profile`, `create_profile`, `import_world`, `export_client_zip`, `import_client_mods`.

The daemon must be running (`npm run dev` or `npm start`). `MINESERVER_URL` overrides the base URL.

## Diagnosis playbook

1. `debug_snapshot` (or `GET /api/debug/snapshot`). Look at `status.server.status`,
   `status.server.lastStopReason`, `recentLogs`, `latestCrashReport`.
2. **Won't start, status stays `stopped`** → `status.setup`: `javaOk`, `eulaAccepted`, `launcherJarPresent`.
3. **Exits immediately** → `lastStopReason`. "EULA" means eula.txt; otherwise read `recentLogs` for
   `Mixin` / `Incompatible mods` — a mod built for another Minecraft version. Disable it in the profile.
4. **Crashed after Done** → `recent_crash_report`; the first "Caused by" names the mod.
5. **Friend can't connect** → `tunnel_status`: `publicAddress` must be set and `status` = running; then
   confirm their name is whitelisted (`send_command "whitelist list"`).
6. **LAN player can't connect** → Windows Firewall prompt for java.exe was declined; allow on private
   networks. Server binds 0.0.0.0:25565 by default.
7. **Mods "missing" in game** → `serverModsDir` in the snapshot vs `activeProfile.enabledMods`; a mod
   flagged `parseError` in `mods` is probably not a Fabric jar.

## Rules for agents

- Do not start or stop the server while players are online without being asked.
- Never read or print `data/playit/playit.toml`.
- Do not delete worlds. Ever. Ask.
- Toggling mods is safe at any time (it only affects the next start).
