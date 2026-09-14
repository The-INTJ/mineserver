# September 13–14 maintenance handoff

Status at pause: implementation is built and validated on `improve/server-reliability`.
The user requested wrapping up to shut down the computer. No main-branch integration was approved.
The new manager has **not replaced the currently running old process**; see deployment below.

## Tonight's save and preservation

The original game finished saving on September 13 at **11:18:32 PM Eastern**. Minecraft logged
all chunks saved for overworld, nether, end and skull cavern, then "All dimensions are saved".
The old manager reports Java exited with code 0 and the server is stopped with zero players.
`level.dat` has a matching 11:18:32 PM write time. The saved player files were also present.

Before implementation, a complete local baseline was copied to:

`D:/MineserverBackups/baseline-2026-09-13-231832/`

It includes `data` (worlds, profiles, mods, runtime configuration and backups), old compiled `dist`,
`application-before.zip`, and a SHA-256 manifest of the 276 final-world files. Playit credentials
were excluded. Preserve this directory; it is outside automatic backup retention.

At 12:16 AM Eastern, every original world file matched that manifest byte-for-byte. The same check
also matched all 373 mod-library files, three profiles, 293 runtime mod jars, 937 runtime config
files and 5,290 KubeJS files against the baseline. Evidence is in
`baseline-2026-09-13-231832/preservation-verification.json`. Tests never started the live world.
No client jar changes, pack updates, original profile changes or world replacements were made.

## Implemented

- Independent Java guardian: saves/stops on manager IPC loss, holds a runtime lock and writes a
  durable exit/save receipt. Save confirmations recognize actual server messages, not chat text.
- Serialized lifecycle requests, exclusive manager ownership, startup failures that refuse missing
  enabled jars, bounded graceful shutdown and deliberate forced-stop reporting.
- Optional runtime-crash recovery with 30/60/120-second delays, maximum three attempts per 15-minute
  manager session; Stop cancels pending recovery. Startup failures do not retry automatically.
- Detached production launcher: `npm start` / `npm run play` return after manager readiness.
  `npm run manager:stop` gracefully stops the new manager and game.
- Durable incident records and manager events; corrected misleading FATAL classification and stale
  crash-report selection; asynchronous bounded/rotated capture; bounded SSE and compressed-log reads.
- Save-now button/API/MCP tool, incident-history API/MCP tool, lag-warning counts, and bounded JVM
  GC/safepoint/native-error diagnostics. Existing 8 GiB heap and gameplay settings are preserved.
- Verified second-drive mirrors of completed FTB archives, reserve-space/retention/error reporting,
  safe new-directory restoration with CRC checks, backup-age warning, and restore-test date.
- Playit process errors contained within tunnel handling; serialized managed-agent startup reuses
  existing tunnel IDs/addresses. A configured external address is no longer called a live connection.
- Localhost API origin/host checks and updated operational documentation.

Local `data/reliability.json` is configured with `autoRestart: true` and
`backupDirectory: "D:/MineserverBackups/rolling"`. A standalone initial scan mirrored all five
completed source archives successfully and verified their SHA-1 checksums. The newest FTB archive
is from 11 PM; the full baseline above preserves the later 11:18 PM final save. Continuous mirroring
begins when the new manager starts. Source FTB configuration remains every 30 minutes/five copies.

## Validation evidence

`npm run check` passed: type checking, lint, **59 tests across 10 files**, Node build and UI build.
Tests cover missing mods, duplicate starts, guardian disconnect, forced stop, save acknowledgement,
log failures/rotation, runtime crash recovery, backup corruption/unsafe restore paths, external
tunnel reporting and Playit spawn failure. The one-time PowerShell migration helper was syntax
checked but was not executed elevated.

Real-game tests ran against copies under `D:/MineserverBackups/validation-2026-09-14`, bound only to
`127.0.0.1:25585`, without a tunnel:

1. Tonight's final saved-world copy loaded with the matching Sunlit Valley pack/Java 17. It reported
   20 TPS and 0.439 ms mean overall tick time while empty, acknowledged `save-all flush`, saved all
   four dimensions on Stop and exited code 0 without force. See `result.json`.
2. The FTB 11 PM archive was restored into `D:/MineserverBackups/restored-ftb-2026-09-14`: 268 files,
   171,432,211 uncompressed bytes, with every file's CRC checked. A further copy of that restoration
   loaded with the matching pack. Its manager then exited intentionally without a cleanup hook.
   The independent guardian detected lost IPC, confirmed saving at 12:17:31 AM and recorded Java
   exit code 0 at 12:18:18 AM, without force. See `emergency-result.json` and its referenced receipt.

An earlier attempt at the second test was interrupted around the Codex usage-limit interruption
before it reached ready; it was not counted as a pass. The later background test above completed.
All test Java processes finished. The original world remained stopped throughout.

The empty-server measurement is not a player-load benchmark. No claim of increased gameplay FPS
or exploration TPS is warranted. GC/lag evidence is now available for subsequent targeted tuning.

## Deployment status and tomorrow's start

The old dashboard remains Node PID 46336, created `2026-09-14T00:46:40.0153460Z`, listening on 3400.
It runs at a privilege level this session cannot terminate: `Stop-Process` returned **Access is
denied**. A subsequent `npm start` correctly detected the existing dashboard and did not create
another manager. No UAC prompt was opened and no unrelated process was stopped.

**A normal Windows shutdown/reboot clears the old manager.** After that:

1. Open an ordinary, non-administrator terminal in `E:/Coding/mineserver` and run `npm start`.
   The new compiled build is already present. `npm run play` also works if a rebuild is desired.
2. Open `http://127.0.0.1:3400`, verify the saved `sunlit-valley` profile, and press **Start**.
3. Keep the separately installed Playit application/service running for remote friends. Its service
   was running during this session, configured with Manual start, and a Playit Tray login entry is
   registered; actual behavior after reboot has not been tested. Check the Playit app after reboot
   before friends connect. Use the existing address and existing clients/jars.

If the PC is only put to sleep and the old dashboard remains, the code swap still needs completing.
The reviewable helper `tools/stop-legacy-manager.ps1` can stop only the verified idle old manager
from an elevated terminal; it validates PID, creation time, data path, empty/stopped state and ports.
It never launches the replacement elevated. Prefer the normal reboot path for this handoff.

At the next start, verify `/api/status` includes `reliability` and `backups`, automatic recovery is
enabled, the five mirror copies are visible, and Minecraft remains stopped until Start is pressed.
The first run of the new manager creates its first incident record; earlier save evidence lives
in this report and the protected baseline, not a fabricated imported run record.

## Networking decision and remaining work

This installation currently uses **external mode** with the separate installed Playit software.
The bundled agent is present but unclaimed; automatic startup for *managed* Playit mode does not
apply to this external setup. Both tray/service and a separate Playit process were observed.
No Playit secret file was read and no tunnel/address configuration was changed.

Direct forwarding is still undecided. Verizon cellular service alone does not establish CGNAT.
The gateway admin attempt in the earlier session hit a certificate warning; this session did not
use computer control or bypass it. A trusted admin session, gateway WAN addressing, and a test
from an outside connection are needed before deciding. Keep Playit until that trial succeeds.
No router, Windows Firewall, DMZ or adapter changes were made.

Next session: verify the new manager after reboot, check Playit's real external connection, and
measure tick/GC behavior with the normal players before tuning distances, heap, Java patch level,
storage or pregeneration. Do not merge/push main without current-work integration approval.

See `docs/operations.md` for daily commands, exact failure limits, backup retention and safe restore
workflow. See `docs/plans/server-reliability-and-direct-networking.md` for the original incident
evidence and staged networking trial. Application rollback must preserve newer player progress;
never restore an older world merely to roll the manager code back.
