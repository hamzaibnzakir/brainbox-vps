import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "../fuzzy";

describe("fuzzyMatch", () => {
  it("matches substrings with indices", () => {
    const r = fuzzyMatch("prod", "Production VPS");
    expect(r).not.toBeNull();
    expect(r!.indices).toEqual([0, 1, 2, 3]);
  });
  it("matches scattered characters in order", () => {
    const r = fuzzyMatch("ntrm", "New terminal");
    expect(r).not.toBeNull();
    expect(r!.indices.length).toBe(4);
  });
  it("rejects out-of-order characters", () => {
    expect(fuzzyMatch("zx", "xz")).toBeNull();
  });
  it("treats an empty query as a match", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("fuzzyFilter", () => {
  const items = [
    { name: "Database VPS", host: "10.0.0.5" },
    { name: "Production VPS", host: "203.0.113.10" },
    { name: "Development VPS", host: "198.51.100.7" },
  ];
  it("ranks prefix matches first", () => {
    const r = fuzzyFilter(items, "pro", (i) => [i.name, i.host]);
    expect(r[0].item.name).toBe("Production VPS");
  });
  it("searches secondary fields", () => {
    const r = fuzzyFilter(items, "198.51", (i) => [i.name, i.host]);
    expect(r.map((x) => x.item.name)).toEqual(["Development VPS"]);
  });
  it("returns everything for an empty query", () => {
    expect(fuzzyFilter(items, "", (i) => [i.name])).toHaveLength(3);
  });
});
