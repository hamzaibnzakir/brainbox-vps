import { create } from "zustand";
import type { ConnectionStatus, MetricsSnapshot, ServerProfile } from "@/types/generated";
import { api, EVENTS, on } from "@/services/api";

export type ConnState = ConnectionStatus["state"]["state"];

interface ServersState {
  servers: ServerProfile[];
  loaded: boolean;
  statuses: Record<string, ConnectionStatus>;
  metrics: Record<string, MetricsSnapshot>;
  /** Short CPU/mem history per server for sparklines. */
  spark: Record<string, { cpu: number[]; mem: number[] }>;
  /** Rolling history for dashboards (most recent last). */
  history: Record<string, MetricsSnapshot[]>;
  seedHistory: (serverId: string, h: MetricsSnapshot[]) => void;
  load: () => Promise<void>;
  upsert: (p: ServerProfile) => void;
  remove: (id: string) => void;
  setStatus: (s: ConnectionStatus) => void;
  pushMetrics: (m: MetricsSnapshot) => void;
}

export const useServers = create<ServersState>((set, get) => ({
  servers: [],
  loaded: false,
  statuses: {},
  metrics: {},
  spark: {},
  history: {},
  seedHistory: (serverId, h) => {
    const cur = get().history[serverId] ?? [];
    const last = cur[cur.length - 1]?.timestamp ?? 0;
    const merged = [...h.filter((x) => x.timestamp < (cur[0]?.timestamp ?? Infinity)), ...cur].slice(-300);
    if (merged.length !== cur.length || !last) set({ history: { ...get().history, [serverId]: merged } });
  },
  load: async () => {
    const [servers, statuses] = await Promise.all([api.serversList(), api.connectionStatuses()]);
    const map: Record<string, ConnectionStatus> = {};
    for (const s of statuses) map[s.serverId] = s;
    set({ servers, statuses: map, loaded: true });
  },
  upsert: (p) => {
    const list = get().servers;
    const i = list.findIndex((s) => s.id === p.id);
    const next = i >= 0 ? list.map((s) => (s.id === p.id ? p : s)) : [...list, p];
    set({ servers: next.sort((a, b) => a.sortOrder - b.sortOrder) });
  },
  remove: (id) => {
    const { [id]: _s, ...statuses } = get().statuses;
    const { [id]: _m, ...metrics } = get().metrics;
    set({ servers: get().servers.filter((s) => s.id !== id), statuses, metrics });
  },
  setStatus: (s) => set({ statuses: { ...get().statuses, [s.serverId]: s } }),
  pushMetrics: (m) => {
    const prev = get().spark[m.serverId] ?? { cpu: [], mem: [] };
    const cpu = [...prev.cpu, m.cpuPercent].slice(-40);
    const mem = [...prev.mem, m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0].slice(-40);
    const hist = [...(get().history[m.serverId] ?? []), m].slice(-300);
    set({ metrics: { ...get().metrics, [m.serverId]: m }, spark: { ...get().spark, [m.serverId]: { cpu, mem } }, history: { ...get().history, [m.serverId]: hist } });
  },
}));

export function connState(serverId: string | null | undefined): ConnState {
  if (!serverId) return "disconnected";
  return useServers.getState().statuses[serverId]?.state.state ?? "disconnected";
}

export function useConnState(serverId: string | null | undefined): ConnState {
  return useServers((s) => (serverId ? s.statuses[serverId]?.state.state ?? "disconnected" : "disconnected"));
}

export function useServer(serverId: string | null | undefined): ServerProfile | undefined {
  return useServers((s) => s.servers.find((x) => x.id === serverId));
}

let wired = false;
export async function wireServerEvents() {
  if (wired) return;
  wired = true;
  await on<ConnectionStatus>(EVENTS.connectionStatus, (s) => useServers.getState().setStatus(s));
  await on<MetricsSnapshot>(EVENTS.metrics, (m) => useServers.getState().pushMetrics(m));
}
