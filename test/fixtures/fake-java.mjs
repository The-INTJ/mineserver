// Stand-in for the Minecraft server process in tests.
//   node fake-java.mjs [--ignore-stop] [--crash]
// Prints realistic startup lines, then "Done", then echoes stdin commands and exits on "stop".
import readline from "node:readline";

const ignoreStop = process.argv.includes("--ignore-stop");
const crash = process.argv.includes("--crash");
const t = () => new Date().toISOString().slice(11, 19);
const say = (level, msg) => process.stdout.write(`[${t()}] [Server thread/${level}]: ${msg}\n`);

say("INFO", "Loading Minecraft 26.2 with Fabric Loader 0.19.5");
say("INFO", "Starting minecraft server version 26.2");
if (crash) {
  say("ERROR", "Encountered an unexpected exception");
  say("ERROR", "java.lang.RuntimeException: boom");
  process.exit(1);
}
setTimeout(() => say("INFO", 'Done (1.234s)! For help, type "help"'), 50);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "stop" && !ignoreStop) {
    say("INFO", "Stopping the server");
    setTimeout(() => process.exit(0), 20);
  } else if (cmd.startsWith("whitelist add ")) {
    say("INFO", `Added ${cmd.slice(14)} to the whitelist`);
  } else if (cmd === "join") {
    say("INFO", "Steve joined the game");
  } else if (cmd === "leave") {
    say("INFO", "Steve left the game");
  } else {
    say("INFO", `Unknown command: ${cmd}`);
  }
});
