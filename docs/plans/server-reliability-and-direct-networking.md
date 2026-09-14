# Server reliability and direct networking maintenance plan

Status: implementation built and validated on `improve/server-reliability`, paused for the user's overnight shutdown September 14, 2026 (Eastern). The old elevated manager has not been replaced; after reboot, `npm start` launches the new build. See `docs/operations.md` and `docs/maintenance-2026-09-14.md` for delivered behavior and exact handoff. The original observations below remain historical evidence.

## Authorization and operating constraints

- The user subsequently authorized implementation after everyone stopped playing. Preserve the exact
  stopped world and client compatibility; use isolated copies for real-game validation. No full
  computer control: the user is still using the machine. Do not interrupt future active play.
- The user requested this plan and authorized read-only inspection of the router. That does
  not authorize applying router changes during the current session.
- Implementation was explicitly requested after shutdown. AGENTS.md and CLAUDE.md were read;
  the original application and game data were copied before changes.
- Develop on a reviewable branch. No merge, automatic merge, or direct push to main without
  explicit approval covering this work. Do not use watch-mode development against live data.
- Never delete a world or overwrite the live world during a restore test.
- Never read or print data/playit/playit.toml. Keep all credentials, router identifiers,
  public IPs, and player-specific log details out of committed documentation.

## Goals

1. Explain future outages from durable evidence, including manager interruptions.
2. Prevent recoverable manager/logging failures from unnecessarily interrupting Minecraft.
3. Recover safely from genuine crashes without duplicate JVMs or restart loops.
4. Prove that backups can restore the world, with useful retention and a second-drive copy.
5. Measure tick delays before changing performance settings.
6. Determine whether direct inbound access works on this Verizon cellular home connection,
   then compare it with Playit before deciding whether to switch.

## Observed baseline

- Project: E:/Coding/mineserver. Manager UI/API: http://127.0.0.1:3400.
- Active profile: sunlit-valley; Forge 47.4.0; Minecraft 1.20.1.
- Profile describes Sunlit Valley 4.1.5a plus 27 CurseForge-only mods. This is a customized
  assembly; do not assume it exactly matches an upstream server pack.
- Java: 17.0.10. Launch: -Xms2G -Xmx8G, UTF-8 properties, Forge argument file, nogui.
- World: data/worlds/sunlit-valley. Runtime: data/servers/forge-1.20.1.
- Effective level-name: ../../worlds/sunlit-valley (intentional Windows junction workaround).
- Authentication and enforced whitelist enabled. RCON/query disabled. View/simulation
  distance both 10. sync-chunk-writes=false. Minecraft watchdog threshold is 60 seconds.
- Machine: i7-13700K, 64 GB RAM, RTX 3090 Ti. Project/world currently on E: SATA SSD;
  C: NVMe has substantial free space. Java working set was about 5.3 GB at one observation;
  that is not a measurement of live heap occupancy or proof of memory pressure.
- FTB Backups: enabled every 30 minutes, retain five backups, same drive, minimum free space
  configured as zero. Completed backups at 8:00 and 8:30 PM were present.
- Connection: integrated Verizon cellular modem/router; host PC connects to it over Wi-Fi.
  No separate downstream router was reported.

## Incident evidence and limits

September 13, 2026, Eastern time:

| Time | Evidence |
| --- | --- |
| 8:30 PM | FTB backup completed, about 27.6 MB. |
| 8:41:40 PM | Previous stdout log ends with a roughly 3.3-second lag warning. |
| 8:44:30 PM | Archived debug log still shows server-thread save activity. |
| 8:45:22 PM | Last entry in archived debug log, from backup scheduler. |
| 8:46:40 PM | Current manager process created; dist build timestamps immediately precede it. |
| 8:47:07 PM | Current Java server process started. |
| 8:48:49 PM | Minecraft reported ready. |

Relevant files:

- data/logs/server-2026-09-14T00-33-40-942Z.log
- data/servers/forge-1.20.1/logs/debug-1.log.gz at inspection time. Rotating filenames will
  change; preserve the incident log before relying on this name later.
- data/servers/forge-1.20.1/backups/2026-9-13_20-30-0.zip

No new Minecraft crash report, explicit out-of-memory failure, or graceful shutdown sequence
established the cause. Older crash reports concern earlier startup failures. The lag warning
was not the terminal event: the server continued afterward. The user does not know whether
the dashboard became unavailable and thinks it may have remained available.

A manager/external process interruption is plausible, not proven. A manager restart may have
been recovery rather than cause. Windows also reported UDP ephemeral-port exhaustion at
8:35:19 PM; its relevance is unknown. If network symptoms recur, investigate socket ownership
with bounded read-only sampling. Do not attribute this outage to hardware, Playit, or a
specific mod without more evidence.

## Work package 1: durable incident diagnostics

Primary files: src/server/process/server-manager.ts, log-buffer.ts, log-file.ts,
src/server/main.ts, src/server/snapshot.ts, src/shared/types.ts.

- Persist manager-originated events in addition to Java stdout/stderr. Today only Java
  onLine writes to the per-launch file; manager notes live in the memory ring.
- Record launch ID, profile/runtime, timestamps, readiness, stop initiator, requested stop,
  forced termination, child exit code AND signal, and manager lifecycle events.
- Capture manager stderr and fatal errors in durable rotated logs. A fatal diagnostic hook
  must not pretend that continuing after an uncaught exception is safe.
- Persist last completed incident independently of active-run state. On restart identify an
  unfinished previous run as an unclean termination with unknown cause, not a guessed crash.
- Associate crash reports by runtime and launch time; mark older reports as historical.
- Expose bounded incident summaries and log references through API/MCP/UI. Avoid secrets in
  command lines, game commands, tunnel output, or exported diagnostic bundles.
- Add optional rotating GC logs and explicit JVM fatal-error output paths during maintenance.
  Make heap dumps opt-in and capacity-checked because they can be large and contain data.

Acceptance: a simulated unexpected exit remains explainable after manager restart; normal
stop, failed startup, external termination, and old crash reports are distinguishable.

## Work package 2: error handling and lifecycle correctness

Primary files: src/server/process/log-file.ts, java-process.ts, server-manager.ts,
log-classify.ts, src/server/routes/logs.ts.

- Handle file open/write/close errors explicitly; make open wait for success or failure.
  A log-write error should mark diagnostics degraded and report through a separate channel,
  rather than become an unhandled stream error that kills the manager.
- Bound pending file/SSE output; handle slow consumers without unbounded accumulation.
  Verify SSE cleanup on early disconnect and in error paths. The installed Hono stream
  implementation already catches ordinary write failures: do not assume every disconnect
  currently crashes the manager.
- Handle child stdin errors, including exit during a command write. Make finish idempotent,
  scoped to the correct process, and drain final stdout/stderr before closing capture.
- Serialize start/restart/stop requests with a lifecycle lock acquired before asynchronous
  preflight. Concurrent requests must never mutate the runtime or spawn duplicate children.
- Separate log severity from termination classification. A TrustManager FATAL startup message
  currently occupies lastStopReason even while healthy; it must not mask a later real error.
- Review startup silence handling. Silence alone is not proof of failure. Preserve a bounded,
  explicit startup timeout and diagnostics without mistaking a slow healthy boot for a hang.

Acceptance: fake-server tests cover unwritable log destination, stdin closing, concurrent
starts, final output delivery, misleading FATAL messages, and slow/disconnected log clients.

## Work package 3: production supervision and recovery

The current manager exit hook force-kills Java. This avoids orphans but couples every manager
exit to the game. Simply deleting that hook is not a complete fix: it loses safe ownership.

- Choose a documented production launcher independent of editor terminals and tsx watch.
- Define ownership using an exclusive instance lock and validated process identity. Never
  kill an arbitrary PID merely because a stale state file names it.
- Compare two designs before implementation: a stable process supervisor separate from the
  web UI, or a supervised manager that performs controlled shutdown/recovery. Document what
  happens on dashboard crash, manager crash, terminal closure, Windows shutdown, and reboot.
- Preserve graceful stop and a bounded escalation timeout. Persist the reason before killing.
- Make automatic recovery opt-in. Suggested policy: delayed retries, increasing backoff,
  at most three attempts in 15 minutes, then stop with an actionable incident.
- Do not restart after intentional stop, missing runtime/EULA, invalid configuration, or a
  repeat deterministic mod failure. Check world lock/process ownership before every retry.
- Retain Minecraft's watchdog initially; do not disable it to hide stalls.

Acceptance: fake-process fault tests first; later an empty-server maintenance test proves
no duplicate JVM, correct intentional stop behavior, and bounded recovery. Do not intentionally
crash the live world to test this feature.

## Work package 4: backups and safe restoration

- After players leave, gracefully stop and confirm Java exited. Preserve a complete baseline
  copy on a second drive before deployment: world, profiles, runtime configuration/KubeJS,
  mod inventory, and whitelist/ops files. Keep secrets separately and locally.
- The inspected backup contains world region files, level.dat, and player data, but uses ZIP
  entries beginning with ../../worlds/sunlit-valley (Windows separators). Do not naively extract
  it. Implement/choose a restore procedure that maps the known world prefix into an isolated
  destination and rejects all other traversal/absolute paths and unexpected links.
- Validate archive integrity and expected world files; restore to a separate test location.
  Never write to the live world as part of the test. A central-directory listing alone does
  not prove complete restoration.
- Proposed retention: recent half-hourly copies for one day plus daily copies for one week,
  adjusted to measured world size and available capacity. Verify implementation support;
  the existing config describes tiered retention as experimental.
- Add a second-drive copy of completed archives and a free-space reserve. Copy only finalized
  backups. A second internal drive helps with disk failure, not whole-machine loss.
- Record backup age, last success/failure, size, destination health, and restore-test date in
  the dashboard. Include runtime/config metadata needed to recreate the matching modpack.

Acceptance: isolated restore contains expected dimensions/player data and can be opened with
the matching pack in an isolated maintenance test; failures and stale backups are visible.

## Work package 5: measured performance improvements

- Establish tick-time and GC baseline with the normal player group; sample quietly and avoid
  heavy profiler runs during active play unless separately agreed.
- Distinguish generation, simulation, GC, disk, Wi-Fi, and WAN stalls. Record both server tick
  delay and client network latency; they are different failure modes.
- Keep the current 8 GB max heap initially. Adjust only with measured heap/GC evidence.
- Consider simulation distance 6-8 if simulation dominates; change one parameter at a time.
- Consider bounded Chunky pregeneration only while empty, with a chosen radius and disk budget.
- Consider moving data to the available NVMe during a later stopped-server migration; verify
  paths, hardlinks/copy fallback, and backups first. Do not move an active world.
- Consider an Ethernet cable from the host to the gateway. That removes the local Wi-Fi hop,
  while the Verizon tower connection remains cellular. Do not switch adapters mid-session.
- Review a current supported Java 17 patch and pack compatibility during maintenance; do not
  switch Java major or bulk-update mods as an unrelated speculative crash fix.

## Work package 6: Verizon direct-connection feasibility

Verizon documents port forwarding for its cellular home gateways. Cellular service does not
alone establish CGNAT or impossibility. Actual inbound reachability remains unverified.

Read-only inspection attempted at the user-provided local admin hostname. Browser navigation
failed with ERR_CERT_AUTHORITY_INVALID. No password was submitted and no router settings
were changed. Browser policy requires user handoff for certificate-warning bypass; resume
through a user-opened trusted admin session or another normally valid vendor access method.
Do not copy credentials into this plan, source code, logs, screenshots, or commits.

### Read-only discovery

1. Identify gateway model, firmware, cellular WAN state, WAN IPv4/IPv6, LAN subnet, current
   DHCP assignment, and existing forwarding/firewall configuration.
2. Compare gateway WAN IPv4 with externally observed IPv4 on this connection, excluding VPNs.
   A matching public address is promising but not proof of inbound reachability.
3. Private IPv4 ranges (10/8, 172.16/12, 192.168/16) or shared 100.64/10 on the cellular WAN
   indicate an upstream NAT layer. Gateway port forwarding cannot configure carrier NAT.
4. If IPv4 is unavailable, assess end-to-end IPv6 support and firewall requirements for every
   friend before proposing it. DDNS and IP passthrough do not themselves bypass carrier NAT.

### Maintenance-window trial (only after explicit go-ahead)

1. Record existing relevant settings and prepare a precise rollback. No DMZ, blanket firewall
   disablement, gateway reset, or IP-passthrough change is needed for a basic forwarding trial.
2. Reserve the host's LAN IPv4 for the intended adapter; note Wi-Fi and Ethernet have different
   adapter identities. Confirm the game listens on the LAN interface.
3. Forward external TCP 25565 to host TCP 25565. Vanilla Java gameplay uses TCP; add other
   ports only for a specifically identified mod requirement. Never forward manager port 3400.
4. Add/review a narrowly scoped Windows Firewall rule for the server. Keep authenticated
   whitelist access. Do not change world or mod configuration as part of the networking trial.
5. Test from a friend on another internet connection. A same-LAN public-IP test may fail due
   to NAT loopback limitations even when external access works.
6. Keep Playit functioning as fallback. Compare connection success, typical latency, spikes,
   and disconnects from the same remote client at similar times. No saturating speed tests.
7. If successful, configure suitable dynamic DNS without committing update credentials.
   Confirm behavior after a natural WAN address change; do not reboot the gateway during play.
8. Retire Playit only after direct access is proven and the user chooses to switch. Rollback
   consists of returning players to Playit and removing only the trial's forwarding/rule changes.

Tradeoffs: direct access removes the relay/agent dependency and may reduce latency, but does
not eliminate cellular jitter, Verizon outages, or local server failures. It exposes the home
public address. Local host should use 127.0.0.1:25565; household clients can use the host LAN IP
regardless of the remote-access method.

References:

- https://www.verizon.com/support/knowledge-base-302813/
- https://www.verizon.com/support/knowledge-base-227033/
- https://www.verizon.com/support/knowledge-base-301824/

## Delivery and rollback sequence

1. Reconfirm maintenance timing; check players and preserve active work.
2. Prepare changes on a branch with isolated temporary test data and fake Java process.
3. Run repository-required npm run check against the development checkout, never a live
   watch-mode manager. Keep CPU-heavy builds/tests outside gameplay on this shared PC.
4. Review the diff and deployment procedure; obtain current-work integration approval if needed.
5. Gracefully stop, verify exit, make and validate the baseline backup.
6. Deploy diagnostics/error handling first; validate a normal launch, join, save, and stop.
7. Deploy supervision and validate empty-server recovery separately.
8. Perform the networking trial separately so failures have a clear cause and rollback.
9. Preserve the previous application build and configuration. Roll back code/config if checks
   fail; never automatically restore an older world over newer player progress.
10. Report implemented changes, validation evidence, remaining limits, and exact rollback steps.

## Completion checklist

- [x] Historical incidents survive manager restart and distinguish unknown causes.
- [x] Logging failures cannot become unhandled manager errors.
- [x] Lifecycle requests cannot spawn duplicate servers.
- [x] FATAL severity alone does not become a false stop reason.
- [x] Normal shutdown and bounded recovery are tested outside the live world.
- [x] A backup has been restored safely into isolation; retention/copy health is visible.
- [x] Idle copy baseline captured (20 TPS, 0.439 ms overall). Runtime/gameplay tuning is deferred
      until player-load measurements support it; bounded diagnostics are implemented.
- [x] Direct-access blocker documented: trusted gateway session/WAN addressing and an external
      inbound test remain unavailable. Playit retained; no forwarding feasibility assumed.
- [ ] Direct and Playit routes are compared before any migration.
- [x] Credentials remain outside source control and diagnostic output.
