# Operating and recovering mineserver

## Daily use

From `E:/Coding/mineserver`, run `npm start` to launch the existing build or `npm run play` to build
and launch. These start the manager in the background and return when the dashboard is ready.
Open `http://127.0.0.1:3400`, keep the saved profile selected, and press **Start**. Repeating the
launcher connects to the existing manager; it does not create a second game server.

In managed Playit mode, after Minecraft reports ready, the manager starts the existing claimed agent. The previously
saved tunnel and address are reused. Check the Tunnel tab if its process reports an error; the UI
reports the agent process state, not an independently verified end-to-end connection. A tunnel
outage does not require changing the world or clients. Reconnect from the Tunnel tab when needed.

In **external mode**, the separate Playit application/service is responsible for the connection.
Keep it running or check it after reboot. The dashboard deliberately labels a saved external
address **configured**, because storing an address does not verify connectivity. Automatic managed
agent startup does not apply to external mode.

**Save now** runs `save-all flush` and waits up to 30 seconds for acknowledgement. **Stop** sends
Minecraft's normal `stop`, allows 60 seconds for saving and exit, and records whether escalation
was needed. A save confirmation can precede JVM exit by tens of seconds while mods close their
threads. Wait for the stopped state. **Restart** serializes Stop and Start.

Use `npm run manager:stop` to stop both the manager and game gracefully. Closing a launcher terminal
or dashboard tab leaves the background manager running. Use `npm run dev` only with isolated test
data: source edits restart that manager and the guardian shuts down its Java process.

## Ownership and failure behavior

| Event | Result |
| --- | --- |
| Normal Stop | Save/stop request, up to 60 seconds, then forced termination if necessary. |
| Java runtime crash | Incident retained; optional delayed recovery after a run reached ready. |
| Startup/mod/EULA failure | Reported; no automatic recovery loop. Missing enabled jars refuse startup. |
| Manager fatal error | Controlled shutdown requests save; original error goes to manager logs. |
| Abrupt manager exit | Independent guardian detects IPC loss, requests stop and writes its own receipt. |
| Terminal or UI tab closes | Production manager continues in the background. |
| Disk logging failure | Capture degrades visibly; it does not deliberately stop the game. |
| Slow log-stream consumer | Bounded queues disconnect that consumer; reconnect replays recent output. |
| Playit fails to start or exits | Tunnel error is reported separately; Minecraft continues locally. |
| Power failure, forced process-tree termination, OS shutdown deadline | No guaranteed final save. Restore from an intact saved world/backup when necessary. |
| Windows reboot | Run `npm start` and press Start again. No system startup service is installed. |

Windows named-pipe locks exclude duplicate managers per data directory and duplicate guardians per
runtime. Locks vanish on process death. No process is killed based on an old saved PID. A manager
restarted while the old guardian is saving must wait until the runtime lock is released.

The guardian is a small independent Node process (`tools/java-guardian.mjs`) that owns Java's stdin
and captures its exit. This provides a save opportunity when the web/manager process fails. It
does not continue a crashed manager unattended, survive power loss, or guarantee recovery from a
hung JVM. A forced stop is labeled explicitly; "last confirmed save" is a timestamp, not a promise
that every action before a crash reached disk.

`data/reliability.json` enables optional `autoRestart` and `backupDirectory`, and tunes
`worldBackupIntervalMinutes` (default 30, `0` disables) and `worldBackupKeep` (default 5). Recovery waits 30,
60, then 120 seconds, with at most three attempts in a rolling 15-minute manager session. It is
canceled by Stop or manager shutdown; preflight/startup failures require inspection. Recovery
attempt counters reset when the manager itself restarts. Editing this configuration takes effect
after a manager restart.

## Evidence and diagnostics

- `GET /api/status`: current state, latest incident/save, recovery policy and backup health.
- `GET /api/server/incidents`: latest 50 persisted run records. Records remain on disk.
- `POST /api/server/save`: acknowledged save without disconnecting players.
- `GET /api/debug/snapshot`: status, log tail, runtime configuration, and a crash report only if its
  timestamp matches the latest recorded launch. Older reports remain in the log-file list.
- `GET /api/logs?grep=error|timeout`: case-insensitive literal alternatives, not arbitrary regex.
- `GET /api/logs/files/:source/:name?maxChars=30000`: bounded trailing text; `.log.gz` is decompressed.
- MCP includes `save_server` and `incident_history` alongside the existing lifecycle/log tools.

Per-run capture and manager logs rotate at 16 MiB with three older segments; the last 30 log sets
are retained. Capture queues and guardian IPC log queues are limited to 1 MiB. Omitted output is
reported; Minecraft's own logs remain another source. Native JVM error files and bounded GC/
safepoint logs live in the runtime's `logs` directory. Log archives can include player information;
keep them private when sharing diagnostics. Do not read or publish the Playit secret file.

Guardian receipts live beside incident JSON files as `*.guardian.json`; if the manager is absent,
the guardian also writes bounded emergency output to `*.guardian.json.log`. A journal that lacks
a completed receipt is classified as unclean/unknown, not as a fabricated mod failure.

## Backups and restore verification

Forge packs with FTB Backups 2 produce their own world backups every 30 minutes and retain five on
the server drive. Every other profile (all Fabric profiles today) is backed up by mineserver
itself: every 30 minutes while players are online (plus one more after the last player leaves,
if the server is still running then), it
sends `save-off`, waits for an acknowledged `save-all flush`, zips `data/worlds/<world>` (minus
`session.lock`) into `<runtime>/backups/`, then sends `save-on`. The archives use FTB's file names
and `backups.json` manifest (entries marked `backupName: "mineserver"`), so the mirror and
`backup:verify` treat both sources identically. A stop or crash during the archive discards it.
It keeps the newest five per world and never prunes FTB's entries. The Halloween world takes about
6 seconds and 220 MiB per archive. Dashboard "Back up now", `POST /api/server/backup` and the
`backup_world` MCP tool take one immediately.

The optional mirror scans completed FTB manifests each minute. It copies an archive to a
temporary `.part`, checks its SHA-1 against FTB's manifest, then publishes the copy. It reserves
2 GiB of destination free space and retains the latest 48 copies plus one from each of the seven
most recent distinct backup dates. It deletes only mirror files it has indexed; source archives,
world directories, and separate baseline copies are never pruned by this service.

The dashboard reports newest backup time, copy success, restore-test time and errors. It warns if
players have been online for 45 minutes without a completed backup. Verification on copy is not
a continuous bit-rot scan. A second internal drive protects against a single-drive failure, not
loss of the whole computer. Save acknowledgements and world backups have different timestamps;
FTB can lag current play by up to its scheduled interval.

Verify an archive into a **new** empty destination parent path:

```powershell
npm run backup:verify -- "D:/MineserverBackups/rolling/forge-1.20.1/<archive>.zip" sunlit-valley "D:/MineserverBackups/restore-check-new"
```

The destination itself must not exist; its parent must already exist. The verifier checks every
file's CRC, requires `level.dat`, and accepts only the expected world root. Legacy FTB entries
beginning `../../worlds/<name>/` are remapped deliberately. Further traversal, absolute paths,
links, duplicate names and unsafe Windows names are refused. A failed check can leave a partial
test directory; it never replaces an existing world.

For an actual recovery, stop and verify that Java exited, preserve the current world in full,
inspect the restored copy, and test it with the matching pack on an isolated local port. Do not
replace newer player progress automatically. World archives need matching mods/configuration;
keep a full stopped-server baseline before changing pack versions. The initial verified baseline
and validation evidence are recorded in the maintenance report.

## Performance and networking

The maintenance build keeps the 8 GiB heap limit, Java major, mods, view/simulation distance,
Minecraft watchdog, world paths and gameplay configuration. It adds bounded asynchronous logging,
lag-warning counts and JVM diagnostics. These reduce diagnostic failure risks and enable informed
tuning; they do not establish a measured increase in gameplay FPS or TPS.

Use `forge tps` to sample server tick time, and compare GC/safepoint records with lag incidents.
Empty-server measurements do not predict exploration with three players. Measure that workload
before lowering distances, changing heap, migrating storage or pregenerating chunks. Host players
can connect directly to `127.0.0.1:25565`; remote friends continue using the existing Playit address.

Verizon direct forwarding remains a separate trial. The gateway's actual WAN addressing and an
external inbound test are needed. Keep TCP 3400 private; no router/firewall changes are part of
this deployment. The detailed network discovery and rollback steps remain in the maintenance plan.

## Application rollback

Keep the improved checkout on its review branch until integration is approved. The pre-change
application source and compiled output are preserved in the initial baseline. Stop the manager
before changing application versions. Run a restored old application from a separate checkout
pointed deliberately at the same data only after confirming no current manager or guardian owns
it. Never roll a world back merely to roll application code back, and never change the mod set to
debug a manager failure. The old manager lacks the new guardian behavior and should be used only
as a temporary recovery option.
