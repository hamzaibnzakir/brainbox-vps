/**
 * Workspaces and tabs. A workspace remembers its servers, open tabs, terminal
 * layouts (incl. tmux session names for re-attaching), file locations,
 * selected server and panel layout — persisted continuously so the app can
 * restore after a restart or a crash.
 */
import { create } from "zustand";
import type { Workspace } from "@/types/generated";
import { api } from "@/services/api";
import { useUi } from "./ui";

export type ServerToolKind = "overview" | "terminal" | "files" | "processes" | "docker" | "services" | "logs" | "ports" | "git" | "tunnels" | "commands" | "editor";
export type GlobalKind = "home" | "settings" | "broadcast" | "local-terminal" | "local-files" | "all-tunnels" | "all-commands" | "known-hosts";
export type TabKind = ServerToolKind | GlobalKind;

export type PaneSpec =
  | { kind: "ssh"; serverId: string; tmuxSession?: string | null; command?: string | null; cwd?: string | null; title?: string | null }
  | { kind: "local"; shellId?: string | null; cwd?: string | null };

export type PaneNode =
  | { type: "leaf"; id: string; spec: PaneSpec }
  | { type: "split"; id: string; dir: "row" | "column"; sizes: number[]; children: PaneNode[] };

export interface Tab {
  id: string;
  kind: TabKind;
  serverId: string | null;
  title?: string;
  // Per-kind state (terminal layout, file paths, editor path…).
  data: Record<string, any>;
}

export interface WorkspaceLayout {
  tabs: Tab[];
  activeTabId: string | null;
  selectedServerId: string | null;
  ui?: { sidebarWidth?: number; sidebarVisible?: boolean; bottomOpen?: boolean; bottomHeight?: number; aiOpen?: boolean; aiWidth?: number };
  pinnedTools?: ServerToolKind[];
}

const SINGLETON_SERVER_TOOLS: ServerToolKind[] = ["overview", "files", "processes", "docker", "services", "logs", "ports", "git", "tunnels", "commands"];
const SINGLETON_GLOBAL: GlobalKind[] = ["home", "settings", "broadcast", "all-tunnels", "all-commands", "known-hosts"];

export const DEFAULT_PINNED: ServerToolKind[] = ["overview", "terminal", "files", "processes", "docker", "services", "logs", "ports", "git", "tunnels", "commands"];

let idSeq = 0;
export const newId = (p = "t") => `${p}${Date.now().toString(36)}${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function leaf(spec: PaneSpec): PaneNode {
  return { type: "leaf", id: newId("p"), spec };
}

interface WorkspaceState {
  ready: boolean;
  workspaces: Workspace[];
  currentId: string | null;
  tabs: Tab[];
  activeTabId: string | null;
  selectedServerId: string | null;
  pinnedTools: ServerToolKind[];
  dirty: Record<string, boolean>;

  init: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string, serverIds: string[]) => Promise<Workspace>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  setWorkspaceServers: (id: string, serverIds: string[]) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;

  openTab: (kind: TabKind, serverId?: string | null, data?: Record<string, any>, opts?: { newTab?: boolean; background?: boolean }) => string;
  closeTab: (id: string, force?: boolean) => Promise<boolean>;
  closeOthers: (id: string) => Promise<void>;
  closeAll: () => Promise<void>;
  activate: (id: string) => void;
  cycle: (dir: 1 | -1) => void;
  moveTab: (from: number, to: number) => void;
  updateTab: (id: string, patch: Record<string, any>) => void;
  setDirty: (id: string, dirty: boolean) => void;
  selectServer: (id: string | null) => void;
  setPinnedTools: (t: ServerToolKind[]) => void;
  persist: () => void;
  flush: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const closeHooks = new Set<(t: Tab) => void>();
/** Called when a tab is closed by the user (not on workspace switch). */
export function onTabClosed(fn: (t: Tab) => void): () => void {
  closeHooks.add(fn);
  return () => closeHooks.delete(fn);
}

function currentLayout(s: WorkspaceState): WorkspaceLayout {
  const ui = useUi.getState();
  return {
    tabs: s.tabs,
    activeTabId: s.activeTabId,
    selectedServerId: s.selectedServerId,
    pinnedTools: s.pinnedTools,
    ui: { sidebarWidth: ui.sidebarWidth, sidebarVisible: ui.sidebarVisible, bottomOpen: ui.bottomOpen, bottomHeight: ui.bottomHeight, aiOpen: ui.aiOpen, aiWidth: ui.aiWidth },
  };
}

function applyLayout(set: (p: Partial<WorkspaceState>) => void, layout: Partial<WorkspaceLayout> | null | undefined) {
  const tabs = Array.isArray(layout?.tabs) && layout!.tabs.length ? layout!.tabs : [{ id: newId(), kind: "home" as TabKind, serverId: null, data: {} }];
  const active = layout?.activeTabId && tabs.some((t) => t.id === layout.activeTabId) ? layout.activeTabId : tabs[0].id;
  set({ tabs, activeTabId: active, selectedServerId: layout?.selectedServerId ?? null, pinnedTools: layout?.pinnedTools?.length ? layout.pinnedTools : DEFAULT_PINNED, dirty: {} });
  const u = layout?.ui;
  if (u) {
    useUi.getState().set({
      sidebarWidth: u.sidebarWidth ?? 272,
      sidebarVisible: u.sidebarVisible ?? true,
      bottomOpen: u.bottomOpen ?? false,
      bottomHeight: u.bottomHeight ?? 240,
      aiOpen: u.aiOpen ?? false,
      aiWidth: u.aiWidth ?? 400,
    });
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ready: false,
  workspaces: [],
  currentId: null,
  tabs: [],
  activeTabId: null,
  selectedServerId: null,
  pinnedTools: DEFAULT_PINNED,
  dirty: {},

  init: async () => {
    let list = await api.workspacesList();
    if (!list.length) {
      list = [await api.workspaceCreate("My Workspace", [])];
    }
    const last = await api.uiStateGet("lastWorkspace");
    const ws = list.find((w) => w.id === last) ?? list[0];
    set({ workspaces: list, currentId: ws.id });
    applyLayout(set, ws.layout as WorkspaceLayout);
    set({ ready: true });
  },

  switchWorkspace: async (id) => {
    if (id === get().currentId) return;
    await get().flush();
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) return;
    set({ currentId: id });
    applyLayout(set, ws.layout as WorkspaceLayout);
    await api.uiStateSet("lastWorkspace", id);
  },

  createWorkspace: async (name, serverIds) => {
    const w = await api.workspaceCreate(name, serverIds);
    set({ workspaces: [...get().workspaces, w] });
    return w;
  },
  renameWorkspace: async (id, name) => {
    const w = get().workspaces.find((x) => x.id === id);
    if (!w) return;
    const saved = await api.workspaceSave({ ...w, name, layout: id === get().currentId ? currentLayout(get()) : w.layout });
    set({ workspaces: get().workspaces.map((x) => (x.id === id ? saved : x)) });
  },
  setWorkspaceServers: async (id, serverIds) => {
    const w = get().workspaces.find((x) => x.id === id);
    if (!w) return;
    const saved = await api.workspaceSave({ ...w, serverIds, layout: id === get().currentId ? currentLayout(get()) : w.layout });
    set({ workspaces: get().workspaces.map((x) => (x.id === id ? saved : x)) });
  },
  deleteWorkspace: async (id) => {
    if (get().workspaces.length <= 1) return;
    await api.workspaceDelete(id);
    const rest = get().workspaces.filter((w) => w.id !== id);
    set({ workspaces: rest });
    if (get().currentId === id) {
      set({ currentId: null });
      await get().switchWorkspace(rest[0].id);
    }
  },

  openTab: (kind, serverId = null, data = {}, opts = {}) => {
    const s = get();
    if (!opts.newTab) {
      let existing: Tab | undefined;
      if (SINGLETON_SERVER_TOOLS.includes(kind as ServerToolKind)) existing = s.tabs.find((t) => t.kind === kind && t.serverId === serverId);
      else if (SINGLETON_GLOBAL.includes(kind as GlobalKind)) existing = s.tabs.find((t) => t.kind === kind);
      else if (kind === "editor") existing = s.tabs.find((t) => t.kind === "editor" && t.serverId === serverId && t.data.path === data.path);
      if (existing) {
        if (Object.keys(data).length && kind !== "editor") get().updateTab(existing.id, data);
        if (!opts.background) set({ activeTabId: existing.id });
        if (serverId) set({ selectedServerId: serverId });
        get().persist();
        return existing.id;
      }
    }
    if (kind === "terminal" && !data.layout && serverId) data = { ...data, layout: leaf({ kind: "ssh", serverId }) };
    if (kind === "local-terminal" && !data.layout) data = { ...data, layout: leaf({ kind: "local", shellId: data.shellId ?? null }) };
    const tab: Tab = { id: newId(), kind, serverId, data };
    // Insert after the active tab.
    const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
    const tabs = [...s.tabs];
    tabs.splice(idx >= 0 ? idx + 1 : tabs.length, 0, tab);
    set({ tabs, activeTabId: opts.background ? s.activeTabId : tab.id, selectedServerId: serverId ?? s.selectedServerId });
    get().persist();
    return tab.id;
  },

  closeTab: async (id, force = false) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return true;
    if (!force && s.dirty[id]) {
      const ok = await useUi.getState().confirm({
        title: "Discard unsaved changes?",
        message: `“${tab.data.path ?? "This file"}” has changes that haven't been saved to the server.`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return false;
    }
    closeHooks.forEach((h) => h(tab));
    const idx = s.tabs.findIndex((t) => t.id === id);
    let tabs = s.tabs.filter((t) => t.id !== id);
    if (!tabs.length) tabs = [{ id: newId(), kind: "home", serverId: null, data: {} }];
    const { [id]: _, ...dirty } = s.dirty;
    const activeTabId = s.activeTabId === id ? tabs[Math.min(idx, tabs.length - 1)].id : s.activeTabId;
    set({ tabs, activeTabId, dirty });
    get().persist();
    return true;
  },
  closeOthers: async (id) => {
    for (const t of get().tabs.filter((t) => t.id !== id)) {
      if (!(await get().closeTab(t.id))) return;
    }
  },
  closeAll: async () => {
    for (const t of [...get().tabs]) {
      if (!(await get().closeTab(t.id))) return;
    }
  },
  activate: (id) => {
    const t = get().tabs.find((x) => x.id === id);
    set({ activeTabId: id, selectedServerId: t?.serverId ?? get().selectedServerId });
    get().persist();
  },
  cycle: (dir) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeTabId);
    get().activate(tabs[(i + dir + tabs.length) % tabs.length].id);
  },
  moveTab: (from, to) => {
    const tabs = [...get().tabs];
    const [t] = tabs.splice(from, 1);
    tabs.splice(to, 0, t);
    set({ tabs });
    get().persist();
  },
  updateTab: (id, patch) => {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, data: { ...t.data, ...patch } } : t)) });
    get().persist();
  },
  setDirty: (id, dirty) => {
    if (!!get().dirty[id] === dirty) return;
    set({ dirty: { ...get().dirty, [id]: dirty } });
  },
  selectServer: (id) => {
    set({ selectedServerId: id });
    get().persist();
  },
  setPinnedTools: (t) => {
    set({ pinnedTools: t });
    get().persist();
  },

  persist: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flush(), 700);
  },
  flush: async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const s = get();
    const ws = s.workspaces.find((w) => w.id === s.currentId);
    if (!ws) return;
    const saved = await api.workspaceSave({ ...ws, layout: currentLayout(s) });
    set({ workspaces: get().workspaces.map((w) => (w.id === saved.id ? saved : w)) });
    await api.uiStateSet("lastWorkspace", saved.id);
  },
}));

/** Walk a pane tree. */
export function paneLeaves(n: PaneNode): Array<Extract<PaneNode, { type: "leaf" }>> {
  return n.type === "leaf" ? [n] : n.children.flatMap(paneLeaves);
}

/** Split the pane `targetId` in direction `dir`, inserting `spec` after it. */
export function splitPane(root: PaneNode, targetId: string, dir: "row" | "column", spec: PaneSpec): { root: PaneNode; newId: string } {
  const nl = leaf(spec);
  const rec = (n: PaneNode): PaneNode => {
    if (n.type === "leaf") {
      if (n.id !== targetId) return n;
      return { type: "split", id: newId("s"), dir, sizes: [50, 50], children: [n, nl] };
    }
    const idx = n.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
    if (idx >= 0 && n.dir === dir) {
      const children = [...n.children];
      children.splice(idx + 1, 0, nl);
      const size = 100 / children.length;
      return { ...n, children, sizes: children.map(() => size) };
    }
    return { ...n, children: n.children.map(rec) };
  };
  return { root: rec(root), newId: nl.id };
}

/** Remove a pane; returns null if the tree becomes empty. */
export function removePane(root: PaneNode, targetId: string): PaneNode | null {
  if (root.type === "leaf") return root.id === targetId ? null : root;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((c, i) => {
    const r = removePane(c, targetId);
    if (r) {
      children.push(r);
      sizes.push(root.sizes[i] ?? 100 / root.children.length);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...root, children, sizes: sizes.map((s) => (s / total) * 100) };
}

export function updatePaneSizes(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (root.type === "leaf") return root;
  if (root.id === splitId) return { ...root, sizes };
  return { ...root, children: root.children.map((c) => updatePaneSizes(c, splitId, sizes)) };
}

export function updatePaneSpec(root: PaneNode, paneId: string, patch: Partial<PaneSpec>): PaneNode {
  if (root.type === "leaf") return root.id === paneId ? { ...root, spec: { ...root.spec, ...patch } as PaneSpec } : root;
  return { ...root, children: root.children.map((c) => updatePaneSpec(c, paneId, patch)) };
}
