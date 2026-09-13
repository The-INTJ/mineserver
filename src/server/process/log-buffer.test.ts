import { describe, expect, it } from "vitest";
import { LogBuffer } from "./log-buffer.ts";

describe("LogBuffer", () => {
  it("assigns monotonic seq and replays since", () => {
    const b = new LogBuffer(10);
    b.push("stdout", "a");
    b.push("stdout", "b");
    b.push("stderr", "c");
    expect(b.since(1).map((l) => l.text)).toEqual(["b", "c"]);
    expect(b.lastSeq).toBe(3);
  });

  it("wraps at capacity but keeps seq increasing", () => {
    const b = new LogBuffer(3);
    for (let i = 1; i <= 5; i++) b.push("stdout", `l${i}`);
    expect(b.tail(10).map((l) => l.text)).toEqual(["l3", "l4", "l5"]);
    expect(b.tail(10)[0].seq).toBe(3);
  });

  it("tail with grep filters before slicing", () => {
    const b = new LogBuffer();
    b.push("stdout", "x1");
    b.push("stdout", "y");
    b.push("stdout", "x2");
    expect(b.tail(1, /x/).map((l) => l.text)).toEqual(["x2"]);
  });

  it("emits line events", () => {
    const b = new LogBuffer();
    const seen: string[] = [];
    b.on("line", (l) => seen.push(l.text));
    b.note("hi");
    expect(seen).toEqual(["[mineserver] hi"]);
  });
});
