/** Keyboard shortcut parsing/matching ("Ctrl+Shift+T"). */

export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string; // lower-case key or code-like name ("t", "tab", "f11", "`")
}

export function parseChord(s: string): Chord | null {
  const parts = s.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const c: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (const p of parts) {
    if (p === "ctrl" || p === "control" || p === "cmdorctrl") c.ctrl = true;
    else if (p === "shift") c.shift = true;
    else if (p === "alt" || p === "option") c.alt = true;
    else if (p === "meta" || p === "cmd" || p === "win") c.meta = true;
    else c.key = p;
  }
  return c.key ? c : null;
}

export function eventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  if (k === " ") return "space";
  if (k === "esc") return "escape";
  // Use the physical digit for Ctrl+Shift+1 etc. (key would be "!")
  if (e.code?.startsWith("Digit")) return e.code.slice(5);
  if (e.code === "Backquote") return "`";
  if (e.code === "Comma") return ",";
  if (e.code === "Period") return ".";
  if (e.code === "Slash") return "/";
  if (e.code?.startsWith("Key")) return e.code.slice(3).toLowerCase();
  return k;
}

export function matches(e: KeyboardEvent, chord: Chord | string | null): boolean {
  const c = typeof chord === "string" ? parseChord(chord) : chord;
  if (!c) return false;
  return (
    e.ctrlKey === c.ctrl &&
    e.shiftKey === c.shift &&
    e.altKey === c.alt &&
    e.metaKey === c.meta &&
    eventKey(e) === c.key
  );
}

export function chordFromEvent(e: KeyboardEvent): string | null {
  const k = eventKey(e);
  if (["control", "shift", "alt", "meta"].includes(k)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1));
  return parts.join("+");
}

export function prettyChord(s: string): string[] {
  return s.split("+").map((p) => p.trim());
}
