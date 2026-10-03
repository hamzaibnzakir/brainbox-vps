/**
 * Terminal runtime registry. xterm instances and their backend sessions live
 * here, outside React, keyed by pane id — so they survive tab switches,
 * split-layout changes and workspace switches. They are disposed only when the
 * user closes the pane/tab.
 */
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { AppError, TerminalEvent } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { useSettings } from "@/stores/settings";
import { connState, useServers } from "@/stores/servers";
import { useUi } from "@/stores/ui";
import type { PaneSpec } from "@/stores/workspace";
import { terminalTheme } from "./theme";

export type PaneStatus = "idle" | "waiting" | "opening" | "open" | "suspended" | "exited" | "error";

export interface PaneRuntime {
  paneId: string;
  spec: PaneSpec;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  sessionId: string | null;
  status: PaneStatus;
  error: AppError | null;
  exitCode: number | null;
  tmuxSession: string | null;
  opened: boolean;
  listeners: Set<() => void>;
  disposables: IDisposable[];
  unsubServer?: () => void;
  onTmux?: (name: string) => void;
  webgl?: { dispose(): void };
  lastResize?: [number, number];
}

const panes = new Map<string, PaneRuntime>();
const decoder = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function themeMode(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function notify(p: PaneRuntime) {
  p.listeners.forEach((l) => l());
}

function setStatus(p: PaneRuntime, status: PaneStatus, error: AppError | null = null) {
  p.status = status;
  p.error = error;
  notify(p);
}

async function confirmPaste(text: string): Promise<boolean> {
  const s = useSettings.getState().settings;
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!s.confirmMultilinePaste || lines.length <= 1) return true;
  return useUi.getState().confirm({
    title: `Paste ${lines.length} lines?`,
    message: "Multi-line text runs each line as a command in the shell.",
    command: lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n… ${lines.length - 12} more lines` : ""),
    confirmLabel: "Paste",
  });
}

export async function pasteInto(p: PaneRuntime) {
  const text = await platform.readClipboard();
  if (!text) return;
  if (!(await confirmPaste(text))) return;
  p.term.paste(text.replace(/\r?\n/g, "\r"));
  p.term.focus();
}

export function copySelection(p: PaneRuntime): boolean {
  const sel = p.term.getSelection();
  if (!sel) return false;
  void platform.writeClipboard(sel);
  return true;
}

/** Keys the app handles even when a terminal has focus. */
function isAppShortcut(e: KeyboardEvent): boolean {
  if (e.ctrlKey && e.shiftKey && /^Key[TFPWDEBLXKIJ]$|^Digit\d$|^Comma$/.test(e.code)) return true;
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.code === "Tab" || e.code === "F4" || e.code === "Comma" || e.code === "PageUp" || e.code === "PageDown")) return true;
  if (e.ctrlKey && e.shiftKey && e.code === "Tab") return true;
  if (e.ctrlKey && e.altKey && e.code === "KeyF") return true;
  if (e.code === "F11") return true;
  return false;
}

function createRuntime(paneId: string, spec: PaneSpec): PaneRuntime {
  const s = useSettings.getState().settings;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c5cff";
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: `${s.terminalFontFamily}, "JetBrains Mono Variable", monospace`,
    fontSize: s.terminalFontSize,
    lineHeight: s.terminalLineHeight,
    scrollback: s.terminalScrollback,
    cursorStyle: (s.terminalCursorStyle as "bar" | "block" | "underline") || "bar",
    cursorBlink: s.terminalCursorBlink,
    theme: terminalTheme(themeMode(), accent),
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    smoothScrollDuration: 0,
    scrollSensitivity: 1.2,
    allowTransparency: false,
    windowsPty: undefined,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = "11";
  term.loadAddon(
    new WebLinksAddon((ev, uri) => {
      if (ev.ctrlKey || ev.metaKey) void api.openUrl(uri).catch(() => {});
      else useUi.getState().toast({ kind: "info", title: "Ctrl+Click to open link", body: uri, timeout: 2500 });
    }),
  );
  const host = document.createElement("div");
  host.className = "h-full w-full";
  const p: PaneRuntime = {
    paneId,
    spec,
    term,
    fit,
    search,
    host,
    sessionId: null,
    status: "idle",
    error: null,
    exitCode: null,
    tmuxSession: spec.kind === "ssh" ? spec.tmuxSession ?? null : null,
    opened: false,
    listeners: new Set(),
    disposables: [],
  };

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // Copy with Ctrl+C only when there's a selection (otherwise it's SIGINT).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyC" && term.hasSelection()) {
      copySelection(p);
      term.clearSelection();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
      copySelection(p);
      return false;
    }
    if (e.ctrlKey && !e.altKey && e.code === "KeyV") {
      e.preventDefault();
      void pasteInto(p);
      return false;
    }
    if (e.shiftKey && !e.ctrlKey && e.code === "Insert") {
      e.preventDefault();
      void pasteInto(p);
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.code === "Insert") {
      copySelection(p);
      return false;
    }
    if ((p.status === "exited" || p.status === "error") && e.key === "Enter") {
      void restart(p);
      return false;
    }
    return !isAppShortcut(e);
  });

  p.disposables.push(
    term.onData((d) => {
      if (p.sessionId && p.status === "open") void api.terminalWrite(p.sessionId, d).catch(() => {});
    }),
    term.onBinary((d) => {
      if (p.sessionId && p.status === "open") void api.terminalWrite(p.sessionId, d, true).catch(() => {});
    }),
    term.onResize(({ cols, rows }) => {
      if (p.sessionId && (p.lastResize?.[0] !== cols || p.lastResize?.[1] !== rows)) {
        p.lastResize = [cols, rows];
        void api.terminalResize(p.sessionId, cols, rows).catch(() => {});
      }
    }),
    term.onSelectionChange(() => {
      if (useSettings.getState().settings.copyOnSelect && term.hasSelection()) void platform.writeClipboard(term.getSelection());
    }),
    term.onTitleChange(() => notify(p)),
  );
  return p;
}

function onEvent(p: PaneRuntime, ev: TerminalEvent) {
  switch (ev.type) {
    case "data":
      p.term.write(decoder(ev.data));
      break;
    case "suspended":
      setStatus(p, "suspended");
      break;
    case "resumed":
      setStatus(p, "open");
      if (p.term.cols && p.sessionId) void api.terminalResize(p.sessionId, p.term.cols, p.term.rows).catch(() => {});
      break;
    case "exit":
      p.exitCode = ev.code;
      p.sessionId = null;
      p.term.write(`\r\n\x1b[2m[session ended${ev.code != null ? ` with code ${ev.code}` : ""} — press Enter to start a new one]\x1b[0m\r\n`);
      setStatus(p, "exited");
      break;
    case "error":
      setStatus(p, "error", ev.error);
      break;
  }
}

async function openSession(p: PaneRuntime) {
  if (p.status === "opening" || p.status === "open") return;
  const spec = p.spec;
  const cols = Math.max(p.term.cols, 20);
  const rows = Math.max(p.term.rows, 5);
  try {
    if (spec.kind === "ssh") {
      if (connState(spec.serverId) !== "connected") {
        setStatus(p, "waiting");
        waitForServer(p);
        return;
      }
      setStatus(p, "opening");
      const info = await api.terminalOpen({ serverId: spec.serverId, cols, rows, tmuxSession: p.tmuxSession, command: spec.command ?? null, cwd: spec.cwd ?? null }, (ev) => onEvent(p, ev));
      p.sessionId = info.id;
      if (info.tmuxSession && info.tmuxSession !== p.tmuxSession) {
        p.tmuxSession = info.tmuxSession;
        p.onTmux?.(info.tmuxSession);
      }
    } else {
      setStatus(p, "opening");
      const info = await api.terminalOpenLocal(spec.shellId ?? null, cols, rows, spec.cwd ?? null, (ev) => onEvent(p, ev));
      p.sessionId = info.id;
    }
    p.lastResize = [cols, rows];
    setStatus(p, "open");
    if ((p.term.cols !== cols || p.term.rows !== rows) && p.sessionId) void api.terminalResize(p.sessionId, p.term.cols, p.term.rows);
  } catch (e) {
    const err = toAppError(e);
    if (err.code === "not_connected") {
      setStatus(p, "waiting");
      waitForServer(p);
      return;
    }
    setStatus(p, "error", err);
  }
}

function waitForServer(p: PaneRuntime) {
  if (p.spec.kind !== "ssh" || p.unsubServer) return;
  const sid = p.spec.serverId;
  p.unsubServer = useServers.subscribe((st) => {
    if (st.statuses[sid]?.state.state === "connected" && p.status === "waiting") {
      p.unsubServer?.();
      p.unsubServer = undefined;
      void openSession(p);
    }
  });
}

export async function restart(p: PaneRuntime) {
  if (p.sessionId) await api.terminalClose(p.sessionId).catch(() => {});
  p.sessionId = null;
  p.status = "idle";
  p.term.reset();
  await openSession(p);
}

/** Get (or create) the runtime for a pane and attach it to a container. */
export function attachPane(paneId: string, spec: PaneSpec, container: HTMLElement, onTmux?: (name: string) => void): PaneRuntime {
  let p = panes.get(paneId);
  if (!p) {
    p = createRuntime(paneId, spec);
    panes.set(paneId, p);
  }
  p.onTmux = onTmux;
  if (p.host.parentElement !== container) container.appendChild(p.host);
  if (!p.opened) {
    p.term.open(p.host);
    p.opened = true;
    try {
      // GPU rendering when available; falls back to the DOM renderer.
      void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
        if (!panes.has(paneId) || p!.webgl) return;
        try {
          const gl = new WebglAddon();
          gl.onContextLoss(() => {
            gl.dispose();
            p!.webgl = undefined;
          });
          p!.term.loadAddon(gl);
          p!.webgl = gl;
        } catch {
          /* DOM renderer */
        }
      });
    } catch {
      /* ignore */
    }
  }
  requestAnimationFrame(() => {
    try {
      p!.fit.fit();
    } catch {
      /* hidden */
    }
    if (p!.status === "idle") void openSession(p!);
  });
  return p;
}

export function getPane(paneId: string) {
  return panes.get(paneId);
}

export function disposePane(paneId: string) {
  const p = panes.get(paneId);
  if (!p) return;
  panes.delete(paneId);
  p.unsubServer?.();
  if (p.sessionId) void api.terminalClose(p.sessionId).catch(() => {});
  p.disposables.forEach((d) => d.dispose());
  try {
    p.webgl?.dispose();
  } catch {
    /* ignore */
  }
  p.term.dispose();
  p.host.remove();
}

export function fitPane(paneId: string) {
  const p = panes.get(paneId);
  if (!p || !p.host.isConnected || p.host.clientWidth === 0) return;
  try {
    p.fit.fit();
  } catch {
    /* ignore */
  }
}

/** Apply settings/theme changes to every live terminal. */
export function refreshAllTerminals() {
  const s = useSettings.getState().settings;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c5cff";
  for (const p of panes.values()) {
    p.term.options.theme = terminalTheme(themeMode(), accent);
    p.term.options.fontSize = s.terminalFontSize;
    p.term.options.fontFamily = `${s.terminalFontFamily}, "JetBrains Mono Variable", monospace`;
    p.term.options.lineHeight = s.terminalLineHeight;
    p.term.options.cursorStyle = (s.terminalCursorStyle as "bar" | "block" | "underline") || "bar";
    p.term.options.cursorBlink = s.terminalCursorBlink;
    p.term.options.scrollback = s.terminalScrollback;
    fitPane(p.paneId);
  }
}

/** Send text to a pane as if typed (used by the command center). */
export function sendToPane(paneId: string, text: string) {
  const p = panes.get(paneId);
  if (!p?.sessionId) return false;
  void api.terminalWrite(p.sessionId, text);
  p.term.focus();
  return true;
}

export function allPanes(): PaneRuntime[] {
  return [...panes.values()];
}

/** Plain-text dump of every terminal buffer (used by the browser E2E suite only). */
function dumpTerminals(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, p] of panes) {
    const b = p.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    out[id] = lines.join("\n").replace(/\n+$/, "");
  }
  return out;
}
if (typeof __MOCK_BACKEND__ !== "undefined" && __MOCK_BACKEND__) {
  (window as unknown as { __bbxTerminals?: () => Record<string, string> }).__bbxTerminals = dumpTerminals;
}
