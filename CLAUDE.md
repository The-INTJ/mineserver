# mineserver – AI Agent Architecture Reference

## What This Is

A self-hosted **Minecraft Fabric dedicated server manager** for one household PC. A Node daemon owns
the Java server process; a React UI (localhost only) and an MCP server both drive it over the same
HTTP API. Built for: two people playing on the LAN, one friend joining through a playit.gg tunnel,
mods swapped often, worlds kept separate, zero hosting cost. Public repo, MIT.

Runtimes are per profile: `{loader: fabric|forge|neoforge, minecraft, loaderVersion}`. Presets in
`src/shared/constants.ts` (Fabric 26.2 / 0.19.5 is the default; Forge 1.20.1 / 47.4.0 is the modpack
LTS). Each `<loader>-<mc>` gets its own dir under `data/servers/` and its own JDK (25 for 26.x, 21 for
1.21, 17 for 1.20.1), chosen by `src/server/runtime/runtimes.ts`. playit agent pinned at **0.17.1**.

## Architecture

```
src/shared/    types + constants. Runtime-neutral: no Node, no React. The contract for everything.
src/server/    the daemon (Hono on 127.0.0.1:3400). Owns data/, the Java child, the playit child.
  process/     JavaProcess (spawn/stdin/taskkill), LogBuffer (ring + SSE source), ServerManager (state machine)
  runtime/     runtimes.ts (pure: ids, URLs, Java majors, launch args), RuntimeStore (install, JDK pick, per-runtime dirs)
  profiles/    ProfileStore (JSON files), materialize (hardlink plan), server-properties (merge + forced keys)
  mods/        ModLibrary (data/mods/library + cached manifest metadata), mod-jar (fabric.mod.json / mods.toml), mrpack (Modrinth packs)
  worlds/      WorldStore: data/worlds/<name>, import-from-saves (copy), junction at <runtime>/world
  jobs.ts      in-memory registry for long work (modpack import, runtime install); UI/MCP poll it
  whitelist.ts Mojang UUID lookup + whitelist.json in every runtime dir
  export/      client zip (server-only mods excluded) and "sync my client" (copy into .minecraft/mods)
  tunnel/      TunnelManager (off | playit | external), PlayitProvider (install/claim/run), pure parsers
  routes/      one Hono sub-app per area; app.ts mounts them under /api and serves dist/ui
  snapshot.ts  buildStatus() and buildSnapshot() — the single source of truth for GET /status and /debug/snapshot
src/ui/        Vite + React SPA. Talks HTTP + SSE only. No router, no state lib.
src/mcp/       stdio MCP server. Talks HTTP only, so Claude Code can run it without the daemon's module graph.
templates/     server.properties.default, client-readme.txt (committed; copied/merged into data/ at runtime)
data/          GITIGNORED. Everything mutable: server jar, mods, worlds, logs, secrets, whitelist.
```

Import boundaries are enforced by `eslint.config.mjs` (`no-restricted-imports`).

**Profile = world + enabled mods + property overrides + JVM memory.** Start does, in order: link world
junction → rebuild `data/server/mods/` from hardlinks → write `server.properties` (template + overrides +
forced `level-name=world`, `white-list=true`) → open a log file → spawn Java. See
`ServerManager.start()`.

## Key Files

- `src/server/process/server-manager.ts` — the state machine; every other module is a leaf it calls.
- `src/server/profiles/materialize.ts` — pure `planMods()`; the mods dir is always rebuilt, never diffed.
- `src/server/worlds/world-store.ts` — junction handling and the "refuse to delete a real dir" guard.
- `src/server/tunnel/playit-provider.ts` — highest external risk; CLI flags are version-specific.
- `src/server/snapshot.ts` — change here when adding anything an AI should see in `/debug/snapshot`.
- `src/mcp/tools/{read,action}.ts` — tool descriptions are the AI's documentation; keep them precise.

## Critical Gotchas

- **JAVA_HOME lies on the dev machine** (JDK 17) while PATH has 25. `findJava()` ignores JAVA_HOME and
  picks the newest `C:\Program Files\Java\jdk-*`. Override with `MINESERVER_JAVA`.
- **No symlinks.** Windows symlinks need Developer Mode. Worlds use a directory **junction**
  (`fs.symlink(..., "junction")`, no privilege needed). Mods use **hardlinks**; `linkOrCopy()` falls back
  to copy on `EXDEV`, which is why client sync (C:) copies and server mods (E:) link.
- **Never overwrite a library jar in place.** It may be hardlinked into the running server's mods dir.
  `ModLibrary.add()` unlinks first. `planMods()` unlinks every jar and relinks, for the same reason.
- **`nogui` is mandatory** or Java opens a Swing window and stops writing stdout.
- **First launch is slow**: the Fabric launcher downloads the vanilla server jar. Ready timeout is 10 min
  and only logs a warning; it never kills.
- **Kill = `taskkill /T /F`** on Windows. `child.kill()` alone does not reliably end java.exe.
  `main.ts` also kills on `exit`/SIGINT so a dead daemon never leaves an orphaned server.
- **EULA**: the server exits immediately without `eula=true`. Classified as `kind: "eula"`, surfaced by
  `EulaGate`, not shown as a crash.
- **playit 1.0.x is a Windows service** (writes `C:\ProgramData\playit_gg`); we pin **0.17.1**, the last
  single-binary line, so everything stays under `data/playit`. Secret file shape:
  `secret_key = "…"` (toml). Claim flow is `claim generate` → `claim url` → `claim exchange --wait`.
- **The whitelist is the only lock on the door** once a tunnel is up. `white-list=true` is forced.
- **A world remembers its mods**: removing a block-adding mod turns its blocks into air. The UI warns; the
  code does not prevent it.
- **Multi-loader jars are real.** "QuiFabrge" and merged jars carry fabric.mod.json AND mods.toml;
  some Forge jars also ship neoforge.mods.toml. Detection records *every* loader (`ModEntry.loaders`);
  compatibility is "includes the runtime's loader". Tagging by first manifest found skipped 10 real
  Sunlit Valley dependencies (verified 2026-09-13).
- **Modpack env flags are the pack author's opinion.** A client-only mod marked `server: required`
  gets loaded on the server; a missing library (Sunlit Valley 4.1.5 omits FTB Library that `gag`
  needs) gets reported by Forge's ModSorter on boot. Read the first 30 s of the log after an import.
- **Java does not see a Windows junction as a symlink.** `BasicFileAttributes` reports it as
  "other", so 1.20.x/1.21.x `DirectoryValidator` (NOFOLLOW_LINKS) rejects `<runtime>/world` with
  "Path .\world is not a directory" and `allowed_symlinks.txt` never applies. Hence
  `runtimes.worldMode()`: Fabric 26.x keeps the junction (works), Forge/NeoForge use
  `level-name=../../worlds/<name>`. Node's lstat *does* call a junction a symlink; don't be fooled.
- **A Modrinth .mrpack can be a subset of the CurseForge edition.** Modrinth packs may only
  reference Modrinth-hosted files, so CurseForge-exclusive mods (FTB Quests/Teams/Chunks, Pam's,
  SewingKit…) silently vanish while the pack's KubeJS data still references them → "Unbound values
  in registry" / "Failed to parse …structure_set…" on boot. Sunlit Valley: 312 Modrinth files vs
  367 CurseForge. The CF manifest (`projectID`/`fileID`) resolves to filenames via the keyless
  `curseforge.com/api/v1/mods/<p>/files/<f>/download` redirect. (Scratch script only so far; a
  proper "import CurseForge pack" job is the obvious next feature.)
- **A Forge JVM that fails to boot usually doesn't exit.** Version-check and mod thread pools are
  non-daemon. `ServerManager` kills it 15 s after "Failed to start the minecraft server" and, as a
  fallback, after 120 s of no stdout while still `starting`.
- **`npm run dev` hard-kills the game server on every source edit.** tsx watch restarts the daemon, and
  the daemon's exit hook (deliberately) takes the Java child with it, without a graceful `stop`
  (verified 2026-09-13: no orphan, but no "Saving chunks" either). While people are playing, run
  `npm run play` (built, no watch) or `npm run daemon` (tsx, no watch) and don't edit code.

## Development

```
npm run dev          # daemon (tsx watch, :3400) + Vite UI (:3401, proxies /api)  — for coding
npm run play         # build, then the daemon serving dist/ui on :3400            — for playing
npm run check        # typecheck && lint && test && build   ← run before every commit
npm start            # built daemon serving dist/ui on :3400 (no build step)
npm run mcp          # built MCP server on stdio (needs a running daemon)
claude mcp add mineserver -- node E:/Coding/mineserver/dist/mcp/main.js
```

Tests: vitest, colocated `*.test.ts`. `test/server-manager.test.ts` drives the real `ServerManager`
against `test/fixtures/fake-java.mjs` via `spawnOverride`; it exercises junctions, hardlinks and 409s
on a temp data dir. Never test against a real Minecraft server in CI.

Debugging a live server: `GET /api/debug/snapshot` or the `debug_snapshot` MCP tool. Logs:
`data/logs/server-<ts>.log` (daemon capture), `data/server/logs/latest.log` (the game's own),
`data/server/crash-reports/`.

## Repo Conventions

- npm, `"type": "module"`, strict TS, `.ts` extensions in relative imports (tsx dev +
  `rewriteRelativeImportExtensions` build). Prettier 100 cols, double quotes, trailing commas.
- Errors that reach HTTP are `AppError(status, code, message)`; codes are stable and the UI/MCP branch on them.
- Every decision that could surprise a future reader gets a "why" comment at the point of decision.
- Nothing under `data/` is ever committed. Check `git status` before pushing.
- Branch `main`, remote `https://github.com/The-INTJ/mineserver.git`.
