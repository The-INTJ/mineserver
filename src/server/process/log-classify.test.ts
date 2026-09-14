import { describe, expect, it } from "vitest";
import { classify } from "./log-classify.ts";

describe("classify", () => {
  it("detects the Done line and player events in the Forge log format", () => {
    const forge = (msg: string) =>
      `[19:36:33] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: ${msg}`;
    expect(classify(forge('Done (18.390s)! For help, type "help"')).kind).toBe("done");
    expect(classify(forge("Steve joined the game"))).toMatchObject({
      kind: "join",
      player: "Steve",
    });
    expect(classify(forge("Steve left the game"))).toMatchObject({
      kind: "leave",
      player: "Steve",
    });
    expect(
      classify("[19:36:33] [main/WARN] [mixin/]: Mixin config x does not specify minVersion").level,
    ).toBe("WARN");
  });

  it("detects the Done line in vanilla and Fabric formats", () => {
    expect(
      classify('[12:00:00] [Server thread/INFO]: Done (3.456s)! For help, type "help"').kind,
    ).toBe("done");
    expect(
      classify('[12:00:00] [Server thread/INFO] (Minecraft) Done (12,345s)! For help, type "help"')
        .kind,
    ).toBe("done");
  });

  it("extracts players on join and leave", () => {
    expect(classify("[12:00:00] [Server thread/INFO]: Steve joined the game")).toMatchObject({
      kind: "join",
      player: "Steve",
    });
    expect(classify("[12:00:00] [Server thread/INFO]: Steve left the game")).toMatchObject({
      kind: "leave",
      player: "Steve",
    });
    expect(
      classify("[12:00:00] [Server thread/INFO]: Alex lost connection: Disconnected"),
    ).toMatchObject({
      kind: "leave",
      player: "Alex",
    });
  });

  it("flags EULA and crashes", () => {
    expect(
      classify("[12:00:00] [main/WARN]: You need to agree to the EULA in order to run the server.")
        .kind,
    ).toBe("eula");
    expect(
      classify("[12:00:00] [Server thread/ERROR]: Encountered an unexpected exception").kind,
    ).toBe("crash");
    expect(classify("[12:00:00] [Server thread/FATAL]: anything").kind).toBe("other");
    expect(
      classify(
        "[19:21:30] [main/ERROR] [net.minecraft.server.Main/FATAL]: Failed to start the minecraft server",
      ).kind,
    ).toBe("crash");
  });

  it("classifies chat and levels; raw lines pass through", () => {
    expect(classify("[12:00:00] [Server thread/INFO]: <Steve> hello")).toMatchObject({
      kind: "chat",
      player: "Steve",
      level: "INFO",
    });
    expect(classify("[12:00:00] [Server thread/WARN]: Can't keep up!").level).toBe("WARN");
    expect(classify("Picked up JAVA_TOOL_OPTIONS")).toMatchObject({ level: "RAW", kind: "other" });
  });
});
