import { useState } from "react";
import { platform } from "@/services/platform";
import { ArrowRight, Cable, Copy, Edit3, Play, Plus, Power, Square, Trash2, Globe } from "lucide-react";
import type { TunnelConfig, TunnelInput, TunnelKind, TunnelStatus } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { useTunnels } from "@/stores/data";
import { useServers } from "@/stores/servers";
import { toastError, useUi } from "@/stores/ui";
import type { Tab } from "@/stores/workspace";
import { Modal } from "@/components/Modal";
import { openMenu } from "@/components/ContextMenu";
import { Avatar, Badge, Button, Checkbox, EmptyState, Field, IconButton, Input, Segmented, Select, Toolbar } from "@/components/ui";
import { cn, formatBytes } from "@/lib/format";
import { connectServer } from "../servers/actions";
import { connState } from "@/stores/servers";

const KIND_INFO: Record<TunnelKind, { label: string; flag: string; help: string }> = {
  local: { label: "Local", flag: "-L", help: "Open a port on this PC that reaches a service on/through the server (e.g. a database bound to 127.0.0.1)." },
  remote: { label: "Remote", flag: "-R", help: "Open a port on the server that reaches a service on this PC (e.g. expose a local dev server)." },
  dynamic: { label: "SOCKS", flag: "-D", help: "A SOCKS5 proxy on this PC that routes browser/app traffic through the server." },
};

function TunnelEditor({ initial, id, onDone }: { initial: TunnelInput; id: string | null; onDone: (t?: TunnelConfig) => void }) {
  const servers = useServers((s) => s.servers);
  const [t, setT] = useState<TunnelInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<TunnelInput>) => setT({ ...t, ...p });
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.tunnelSave(id, t);
      useTunnels.getState().upsertConfig(r);
      onDone(r);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setSaving(false);
    }
  };
  const info = KIND_INFO[t.kind];
  const bindLabel = t.kind === "remote" ? "Listen on server" : "Listen on this PC";
  const exposed = t.kind !== "remote" && !["127.0.0.1", "localhost", "::1", ""].includes(t.bindHost.trim());
  return (
    <Modal
      open
      onClose={() => onDone()}
      title={id ? "Edit tunnel" : "New SSH tunnel"}
      icon={<Cable size={18} />}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()} data-testid="tunnel-save">
            Save tunnel
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input autoFocus value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Postgres" />
          </Field>
          <Field label="Server">
            <Select value={t.serverId} onChange={(e) => set({ serverId: e.target.value })}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Type" hint={info.help}>
          <Segmented value={t.kind} onChange={(k) => set({ kind: k })} options={(Object.keys(KIND_INFO) as TunnelKind[]).map((k) => ({ value: k, label: `${KIND_INFO[k].label} (${KIND_INFO[k].flag})` }))} />
        </Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label={`${bindLabel} — address`}>
            <Input mono value={t.bindHost} onChange={(e) => set({ bindHost: e.target.value })} placeholder="127.0.0.1" />
          </Field>
          <Field label="Port">
            <Input mono type="number" value={t.bindPort || ""} onChange={(e) => set({ bindPort: Number(e.target.value) })} placeholder="5433" />
          </Field>
        </div>
        {t.kind !== "dynamic" && (
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <Field label={t.kind === "local" ? "Destination (as seen from the server)" : "Destination on this PC"}>
              <Input mono value={t.targetHost} onChange={(e) => set({ targetHost: e.target.value })} placeholder="127.0.0.1" />
            </Field>
            <Field label="Port">
              <Input mono type="number" value={t.targetPort || ""} onChange={(e) => set({ targetPort: Number(e.target.value) })} placeholder="5432" />
            </Field>
          </div>
        )}
        {exposed && <div className="text-[12px] text-warn bg-warn/10 border border-warn/20 rounded-md px-3 py-2">Listening on {t.bindHost} makes this tunnel reachable from other devices on your network.</div>}
        <Checkbox checked={t.autoStart} onChange={(v) => set({ autoStart: v })} label="Start automatically when the server connects" />
        <div className="rounded-md bg-bg-1 border border-line px-3 py-2 font-mono text-[11.5px] text-fg-3">
          ssh {info.flag} {t.kind === "dynamic" ? `${t.bindHost || "127.0.0.1"}:${t.bindPort || "PORT"}` : `${t.bindHost || "127.0.0.1"}:${t.bindPort || "PORT"}:${t.targetHost || "HOST"}:${t.targetPort || "PORT"}`} {servers.find((s) => s.id === t.serverId)?.host}
        </div>
        {error && <div className="text-[12.5px] text-danger">{error}</div>}
      </div>
    </Modal>
  );
}

export async function editTunnel(existing: TunnelConfig | null, preset?: Partial<TunnelInput>) {
  const servers = useServers.getState().servers;
  const initial: TunnelInput = existing
    ? { serverId: existing.serverId, name: existing.name, kind: existing.kind, bindHost: existing.bindHost, bindPort: existing.bindPort, targetHost: existing.targetHost, targetPort: existing.targetPort, autoStart: existing.autoStart }
    : { serverId: servers[0]?.id ?? "", name: "", kind: "local", bindHost: "127.0.0.1", bindPort: 0, targetHost: "127.0.0.1", targetPort: 0, autoStart: false, ...preset };
  return useUi.getState().custom<TunnelConfig>((close) => <TunnelEditor initial={initial} id={existing?.id ?? null} onDone={close} />);
}

async function start(t: TunnelConfig) {
  if (connState(t.serverId) !== "connected" && !(await connectServer(t.serverId))) return;
  try {
    useTunnels.getState().setStatus(await api.tunnelStart(t.id));
  } catch (e) {
    toastError(toAppError(e));
  }
}

async function stop(t: TunnelConfig) {
  await api.tunnelStop(t.id).catch((e) => toastError(toAppError(e)));
  useTunnels.getState().setStatus({ id: t.id, state: "stopped", activeConnections: 0, bytesIn: 0, bytesOut: 0, error: null });
}

async function remove(t: TunnelConfig) {
  if (!(await useUi.getState().confirm({ title: `Delete tunnel “${t.name}”?`, danger: true, confirmLabel: "Delete" }))) return;
  await api.tunnelDelete(t.id);
  useTunnels.getState().removeConfig(t.id);
}

function TunnelCard({ t, st }: { t: TunnelConfig; st?: TunnelStatus }) {
  const server = useServers((s) => s.servers.find((x) => x.id === t.serverId));
  const running = st?.state === "running";
  const waiting = st?.state === "waiting";
  const endpoint = `${t.bindHost}:${t.bindPort}`;
  return (
    <div
      className={cn("rounded-xl border bg-bg-2 p-4 flex flex-col gap-3 transition-colors", running ? "border-ok/30" : "border-line")}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: running ? "Stop" : "Start", icon: running ? <Square size={14} /> : <Play size={14} />, onClick: () => void (running ? stop(t) : start(t)) },
          { label: "Edit…", icon: <Edit3 size={14} />, onClick: () => void editTunnel(t) },
          { label: "Copy local address", icon: <Copy size={14} />, onClick: () => void platform.writeClipboard(endpoint) },
          { type: "separator" },
          { label: "Delete", icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(t) },
        ])
      }
      data-testid="tunnel-card"
    >
      <div className="flex items-center gap-2">
        <div className={cn("h-8 w-8 rounded-lg flex items-center justify-center", running ? "bg-ok/15 text-ok" : "bg-bg-4 text-fg-3")}>{t.kind === "dynamic" ? <Globe size={15} /> : <Cable size={15} />}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-fg truncate">{t.name}</div>
          <div className="text-[11.5px] text-fg-3 truncate">
            {KIND_INFO[t.kind].label} {KIND_INFO[t.kind].flag} · {server?.name ?? "deleted server"}
          </div>
        </div>
        {running ? <Badge tone="ok">running</Badge> : waiting ? <Badge tone="warn">waiting</Badge> : st?.state === "error" ? <Badge tone="danger">error</Badge> : <Badge>stopped</Badge>}
      </div>
      <div className="flex items-center gap-2 font-mono text-[12px] bg-bg-1 border border-line rounded-md px-2.5 py-1.5">
        <span className="text-fg">{t.kind === "remote" ? `server ${endpoint}` : endpoint}</span>
        <ArrowRight size={12} className="text-fg-4 shrink-0" />
        <span className="text-fg-2 truncate">{t.kind === "dynamic" ? "SOCKS5 via server" : t.kind === "remote" ? `this PC ${t.targetHost}:${t.targetPort}` : `${t.targetHost}:${t.targetPort}`}</span>
      </div>
      {st?.error && <div className="text-[12px] text-danger">{st.error.message}</div>}
      <div className="flex items-center gap-2">
        {running ? (
          <span className="text-[11.5px] text-fg-3 tabular">
            {st!.activeConnections} conn · ↓{formatBytes(st!.bytesIn)} ↑{formatBytes(st!.bytesOut)}
          </span>
        ) : (
          <span className="text-[11.5px] text-fg-4 flex items-center gap-1">{t.autoStart && <><Power size={11} /> auto-start</>}</span>
        )}
        <div className="flex-1" />
        <IconButton label="Edit" size="xs" onClick={() => void editTunnel(t)}>
          <Edit3 size={12} />
        </IconButton>
        <IconButton label="Delete" size="xs" tone="danger" onClick={() => void remove(t)}>
          <Trash2 size={12} />
        </IconButton>
        {running || waiting ? (
          <Button size="xs" variant="secondary" icon={<Square size={11} />} onClick={() => void stop(t)}>
            Stop
          </Button>
        ) : (
          <Button size="xs" variant="primary" icon={<Play size={11} />} onClick={() => void start(t)} data-testid="tunnel-start">
            Start
          </Button>
        )}
      </div>
    </div>
  );
}

export function TunnelsView({ tab }: { tab: Tab }) {
  const configs = useTunnels((s) => s.configs);
  const statuses = useTunnels((s) => s.statuses);
  const servers = useServers((s) => s.servers);
  const serverId = tab.kind === "tunnels" ? tab.serverId : null;
  const list = serverId ? configs.filter((c) => c.serverId === serverId) : configs;
  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar>
        <Cable size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">SSH Tunnels</span>
        <span className="text-[12px] text-fg-3">{Object.values(statuses).filter((s) => s.state === "running").length} running</span>
        <div className="flex-1" />
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => void editTunnel(null, serverId ? { serverId } : {})} disabled={!servers.length} data-testid="new-tunnel">
          New tunnel
        </Button>
      </Toolbar>
      <div className="flex-1 overflow-auto p-4">
        {list.length === 0 ? (
          <EmptyState
            icon={<Cable size={20} />}
            title="No tunnels yet"
            body="Forward a port from the server to this PC (databases, admin panels), expose a local port on the server, or create a SOCKS proxy."
            action={<Button variant="primary" icon={<Plus size={13} />} onClick={() => void editTunnel(null, serverId ? { serverId } : {})} disabled={!servers.length}>Create a tunnel</Button>}
          />
        ) : serverId ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {list.map((t) => (
              <TunnelCard key={t.id} t={t} st={statuses[t.id]} />
            ))}
          </div>
        ) : (
          servers
            .filter((s) => list.some((t) => t.serverId === s.id))
            .map((s) => (
              <div key={s.id} className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <Avatar name={s.name} color={s.color} size={20} />
                  <span className="text-[12.5px] font-semibold text-fg-2">{s.name}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
                  {list.filter((t) => t.serverId === s.id).map((t) => (
                    <TunnelCard key={t.id} t={t} st={statuses[t.id]} />
                  ))}
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
