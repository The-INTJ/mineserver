# tools/

Operator scripts that drive a running daemon over its HTTP API. They are how Sunlit Valley got
from "imported" to "Done" on 2026-09-13; none of them touch the process or data/ directly.

| Script | What it does |
|---|---|
| `boot-watch.sh [runtimeId] [jstack] [maxIters]` | Start the active profile and watch it: progress every 60 s, thread-dumps the JVM if Forge's debug.log stops growing, prints the key log lines when it settles. |
| `cf-sync.mjs <manifest.json> <profileId>` | Compare a CurseForge modpack manifest with the library, download what's missing through the keyless CurseForge redirect, enable it in the profile on both sides. Use when a Modrinth .mrpack is a subset of the CurseForge edition. |
| `add-mod.mjs "<name>" <profileId> [loader] [mc]` | Find one mod on Modrinth, download the newest matching jar, add + enable it. |

Run from anywhere with the daemon up on 127.0.0.1:3400 (`node tools/add-mod.mjs "FTB Library" sunlit-valley forge 1.20.1`).
