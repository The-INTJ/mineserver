# mineserver

Self-hosted **Minecraft Fabric server manager** for one PC: a Node daemon that owns the server process,
a browser UI for you, and an MCP server so an AI assistant can operate and debug it.

Made for the household case: two people on the LAN, a friend joining from across the country through a
free [playit.gg](https://playit.gg) tunnel, mods swapped constantly, several worlds, no hosting bill.

- **Profiles**: world + enabled mods + `server.properties` overrides + memory. Switch in one click.
- **Mod library**: every jar stored once; profiles pick from it. Server-side vs client-side detected from
  `fabric.mod.json`.
- **Worlds**: kept apart from your single-player saves; import a save with one click (it copies).
- **Export**: a zip of exactly the mods a friend needs, with a README and the server address.
- **Sync my client**: push the same mod set into your own `.minecraft/mods`.
- **Live console**: SSE log stream, command input, whitelist button.
- **Tunnel**: managed playit.gg agent (install, claim, run) or paste your own address.
- **AI-native**: everything is an HTTP endpoint, `/api/debug/snapshot` returns one diagnostic blob, and
  `src/mcp` exposes it all as MCP tools.

## Requirements

- Windows 10/11 (junctions and hardlinks are used; Linux/macOS should work but are untested)
- Node 22+
- Java 25+ (Minecraft 26.x requires it). The daemon finds `C:\Program Files\Java\jdk-25*` itself.
- Minecraft Java Edition accounts for everyone who joins (the whitelist is always on)

## Setup

### Step 1: Install and run

```bash
git clone https://github.com/The-INTJ/mineserver.git
cd mineserver
npm install
npm run dev
```

Open http://127.0.0.1:3401. The UI binds to localhost only; the game port is the only thing that is
ever exposed.

### Step 2: First-run checklist

The Dashboard walks you through it: accept the Minecraft EULA, download the Fabric launcher (~180 KB;
it fetches the vanilla server on first start), then **Start**. The first start takes a few minutes.

### Step 3: Mods and worlds

**Mods** tab → *Import from .minecraft/mods* pulls your client's jars into the library. **Profiles** tab →
create a profile, tick the mods, activate it. **Worlds** tab → import a single-player save if you want to
keep playing an existing world.

### Step 4: Let a friend in

**Tunnel** tab → playit.gg → Download → Start claim → approve in your browser (free account) → Start
agent. Copy the public address. **Export** tab → export the client zip, send it to your friend with the
address. Add their username with *Whitelist add* on the Dashboard.

### Step 5 (optional): AI assistant

```bash
npm run build
claude mcp add mineserver -- node E:/Coding/mineserver/dist/mcp/main.js
```

Then in Claude Code: "why did the server crash?" → it calls `debug_snapshot` and reads the crash report.

## Layout

```
src/server   daemon (Hono)        src/ui   React SPA (Vite)      src/mcp   MCP server (stdio)
src/shared   types + pinned versions        templates/   server.properties + client README
data/        everything mutable; git-ignored (server jar, mods, worlds, logs, secrets)
```

See [CLAUDE.md](CLAUDE.md) for architecture and gotchas, [AGENTS.md](AGENTS.md) for the API and the
diagnosis playbook.

## Development

```bash
npm run dev      # daemon :3400 + UI :3401
npm run check    # typecheck, lint, tests, build
npm start        # production: built daemon serves the built UI on :3400
```

## License

MIT. Minecraft is a trademark of Mojang; this project downloads the server from Mojang/Fabric at runtime
and never redistributes it.
