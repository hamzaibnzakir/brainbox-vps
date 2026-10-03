/** Transfers, tunnels and saved commands. */
import { create } from "zustand";
import type { Snippet, TransferInfo, TunnelConfig, TunnelStatus } from "@/types/generated";
import { api, EVENTS, on } from "@/services/api";

interface TransfersState {
  items: Record<string, TransferInfo>;
  order: string[];
  load: () => Promise<void>;
  upsert: (t: TransferInfo) => void;
  clearFinished: () => Promise<void>;
}

export const useTransfers = create<TransfersState>((set, get) => ({
  items: {},
  order: [],
  load: async () => {
    const list = await api.transfersList();
    const items: Record<string, TransferInfo> = {};
    for (const t of list) items[t.id] = t;
    set({ items, order: list.map((t) => t.id) });
  },
  upsert: (t) => {
    const exists = !!get().items[t.id];
    set({ items: { ...get().items, [t.id]: t }, order: exists ? get().order : [t.id, ...get().order] });
  },
  clearFinished: async () => {
    await api.transfersClearFinished();
    const items = { ...get().items };
    for (const [id, t] of Object.entries(items)) if (t.state === "completed" || t.state === "cancelled") delete items[id];
    set({ items, order: get().order.filter((id) => items[id]) });
  },
}));

export function activeTransferCount(items: Record<string, TransferInfo>): number {
  return Object.values(items).filter((t) => t.state === "running" || t.state === "queued").length;
}

interface TunnelsState {
  configs: TunnelConfig[];
  statuses: Record<string, TunnelStatus>;
  load: () => Promise<void>;
  setStatus: (s: TunnelStatus) => void;
  upsertConfig: (c: TunnelConfig) => void;
  removeConfig: (id: string) => void;
}

export const useTunnels = create<TunnelsState>((set, get) => ({
  configs: [],
  statuses: {},
  load: async () => {
    const [configs, statuses] = await Promise.all([api.tunnelsList(), api.tunnelStatuses()]);
    const map: Record<string, TunnelStatus> = {};
    for (const s of statuses) map[s.id] = s;
    set({ configs, statuses: map });
  },
  setStatus: (s) => {
    const next = { ...get().statuses };
    if (s.state === "stopped") delete next[s.id];
    else next[s.id] = s;
    set({ statuses: next });
  },
  upsertConfig: (c) => set({ configs: [...get().configs.filter((x) => x.id !== c.id), c].sort((a, b) => a.name.localeCompare(b.name)) }),
  removeConfig: (id) => set({ configs: get().configs.filter((c) => c.id !== id) }),
}));

interface SnippetsState {
  snippets: Snippet[];
  load: () => Promise<void>;
  upsert: (s: Snippet) => void;
  remove: (id: string) => void;
}

export const useSnippets = create<SnippetsState>((set, get) => ({
  snippets: [],
  load: async () => set({ snippets: await api.snippetsList() }),
  upsert: (s) => set({ snippets: [...get().snippets.filter((x) => x.id !== s.id), s] }),
  remove: (id) => set({ snippets: get().snippets.filter((s) => s.id !== id) }),
}));

let wired = false;
export async function wireDataEvents() {
  if (wired) return;
  wired = true;
  await on<TransferInfo>(EVENTS.transfer, (t) => useTransfers.getState().upsert(t));
  await on<TunnelStatus>(EVENTS.tunnel, (s) => useTunnels.getState().setStatus(s));
}
