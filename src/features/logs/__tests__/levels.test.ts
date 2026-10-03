import { describe, expect, it } from "vitest";
import { lineLevel } from "../LogsView";

describe("log severity detection", () => {
  it.each([
    ["2026-10-03 12:00:01 ERROR db: connection refused", "error"],
    ["nginx: [crit] worker failed", "error"],
    ["Traceback (most recent call last):", "error"],
    ["WARN cache miss ratio high", "warn"],
    ["level=warning msg=slow", "warn"],
    ["DEBUG handshake ok", "debug"],
    ["GET /health 200", "info"],
  ])("%s → %s", (line, level) => {
    expect(lineLevel(line)).toBe(level);
  });
});
