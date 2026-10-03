import { describe, expect, it } from "vitest";
import { chordFromEvent, matches, parseChord } from "../keys";

const ev = (init: KeyboardEventInit & { code?: string }) => new KeyboardEvent("keydown", init);

describe("keyboard chords", () => {
  it("parses chords", () => {
    expect(parseChord("Ctrl+Shift+T")).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "t" });
    expect(parseChord("Ctrl+")).toBeNull();
    expect(parseChord("")).toBeNull();
  });
  it("matches events exactly", () => {
    expect(matches(ev({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+T")).toBe(true);
    expect(matches(ev({ key: "t", code: "KeyT", ctrlKey: true }), "Ctrl+Shift+T")).toBe(false);
    expect(matches(ev({ key: "k", code: "KeyK", ctrlKey: true }), "Ctrl+K")).toBe(true);
  });
  it("uses physical digits with shift", () => {
    expect(matches(ev({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+1")).toBe(true);
  });
  it("records chords from events", () => {
    expect(chordFromEvent(ev({ key: "p", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+P");
    expect(chordFromEvent(ev({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
    expect(chordFromEvent(ev({ key: "F11", code: "F11" }))).toBe("F11");
  });
});
