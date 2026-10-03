import { describe, expect, it } from "vitest";
import { formatBytes, formatBytesPair, formatDuration, formatPercent, formatRate, initials, permString, clamp, colorFor } from "../format";

describe("formatBytes", () => {
  it("handles small and missing values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });
  it("scales through units", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(160 * 1024 ** 3)).toBe("160 GB");
  });
});

describe("formatBytesPair", () => {
  it("shares the total's unit", () => {
    expect(formatBytesPair(97 * 1024 ** 3, 160 * 1024 ** 3)).toBe("97 / 160 GB");
    expect(formatBytesPair(3.8 * 1024 ** 3, 8 * 1024 ** 3)).toBe("3.8 / 8.0 GB");
    expect(formatBytesPair(512 * 1024 ** 2, 2 * 1024 ** 3)).toBe("0.5 / 2.0 GB");
  });
  it("handles bytes and missing values", () => {
    expect(formatBytesPair(10, 100)).toBe("10 / 100 B");
    expect(formatBytesPair(null, 5)).toBe("—");
  });
});

describe("misc formatters", () => {
  it("formats rates", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(-5)).toBe("0 B/s");
    expect(formatRate(2048)).toBe("2.0 KB/s");
  });
  it("formats durations", () => {
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(65)).toBe("1m 5s");
    expect(formatDuration(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatDuration(14 * 86400 + 11 * 3600)).toBe("14d 11h");
    expect(formatDuration(undefined)).toBe("—");
  });
  it("formats percents", () => {
    expect(formatPercent(42.42, 1)).toBe("42.4%");
    expect(formatPercent(null)).toBe("—");
  });
  it("builds permission strings", () => {
    expect(permString(0o755)).toBe("-rwxr-xr-x");
    expect(permString(0o644, true)).toBe("drw-r--r--");
    expect(permString(0o600)).toBe("-rw-------");
  });
  it("derives initials", () => {
    expect(initials("Production VPS")).toBe("PV");
    expect(initials("db")).toBe("DB");
    expect(initials("  ")).toBe("?");
  });
  it("clamps and colors deterministically", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(colorFor("abc")).toBe(colorFor("abc"));
  });
});
