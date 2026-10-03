import { describe, expect, it } from "vitest";
import { leaf, paneLeaves, removePane, splitPane, updatePaneSizes, updatePaneSpec, type PaneNode } from "../workspace";

const ssh = (serverId: string) => ({ kind: "ssh" as const, serverId });

describe("terminal pane tree", () => {
  it("splits a single pane into two", () => {
    const root = leaf(ssh("a"));
    const { root: r, newId } = splitPane(root, root.id, "row", ssh("a"));
    expect(r.type).toBe("split");
    expect(paneLeaves(r).map((l) => l.id)).toEqual([root.id, newId]);
  });

  it("appends to an existing split in the same direction", () => {
    const a = leaf(ssh("a"));
    const s1 = splitPane(a, a.id, "row", ssh("b"));
    const s2 = splitPane(s1.root, a.id, "row", ssh("c"));
    const r = s2.root as Extract<PaneNode, { type: "split" }>;
    expect(r.children).toHaveLength(3);
    expect(r.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(100);
    expect(paneLeaves(r).map((l) => (l.spec as { serverId: string }).serverId)).toEqual(["a", "c", "b"]);
  });

  it("nests splits in a different direction", () => {
    const a = leaf(ssh("a"));
    const s1 = splitPane(a, a.id, "row", ssh("b"));
    const s2 = splitPane(s1.root, s1.newId, "column", ssh("c"));
    expect(paneLeaves(s2.root)).toHaveLength(3);
    const r = s2.root as Extract<PaneNode, { type: "split" }>;
    expect(r.children[1].type).toBe("split");
  });

  it("removes panes and collapses single-child splits", () => {
    const a = leaf(ssh("a"));
    const s1 = splitPane(a, a.id, "row", ssh("b"));
    const r = removePane(s1.root, s1.newId);
    expect(r).toEqual(a);
    expect(removePane(a, a.id)).toBeNull();
  });

  it("renormalizes sizes after removal", () => {
    const a = leaf(ssh("a"));
    let root = splitPane(a, a.id, "row", ssh("b")).root;
    const third = splitPane(root, a.id, "row", ssh("c"));
    root = removePane(third.root, third.newId)!;
    const r = root as Extract<PaneNode, { type: "split" }>;
    expect(r.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(100);
  });

  it("updates sizes and specs by id", () => {
    const a = leaf(ssh("a"));
    const s = splitPane(a, a.id, "row", ssh("b"));
    const split = s.root as Extract<PaneNode, { type: "split" }>;
    const resized = updatePaneSizes(split, split.id, [30, 70]) as Extract<PaneNode, { type: "split" }>;
    expect(resized.sizes).toEqual([30, 70]);
    const renamed = updatePaneSpec(resized, s.newId, { title: "logs" } as never);
    expect((paneLeaves(renamed)[1].spec as { title?: string }).title).toBe("logs");
  });
});
