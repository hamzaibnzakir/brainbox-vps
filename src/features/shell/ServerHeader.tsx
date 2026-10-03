import { Plug, RefreshCw, Unplug, Pencil, ShieldCheck } from "lucide-react";
import { useServers } from "@/stores/servers";
import { useUi } from "@/stores/ui";
import { useWorkspace, type ServerToolKind } from "@/stores/workspace";
import { Avatar, Button, StatusDot } from "@/components/ui";
import { cn, formatDuration } from "@/lib/format";
import { SERVER_TOOLS } from "../tools";
import { connectServer, disconnectServer, openTool } from "../servers/actions";

/** The server "workspace" strip: identity, connection state and its tools. */
export function ServerHeader({ serverId, activeKind }: { serverId: string; activeKind: string }) {
  const s = useServers((st) => st.servers.find((x) => x.id === serverId));
  const status = useServers((st) => st.statuses[serverId]);
  const metrics = useServers((st) => st.metrics[serverId]);
  const pinned = useWorkspace((w) => w.pinnedTools);
  const openEditor = useUi((u) => u.openServerEditor);
  if (!s) return null;
  const state = status?.state.state ?? "disconnected";
  const label =
    state === "connected"
      ? `Connected${status?.latencyMs != null ? ` · ${status.latencyMs} ms` : ""}${metrics ? ` · up ${formatDuration(metrics.uptimeSecs)}` : ""}`
      : state === "reconnecting"
        ? `Reconnecting… (attempt ${(status!.state as { attempt: number }).attempt})`
        : state === "connecting"
          ? "Connecting…"
          : state === "failed"
            ? (status!.state as { error: { title: string } }).error.title
            : "Disconnected";
  return (
    <div className="flex items-center h-11 px-3 gap-3 border-b border-line bg-bg-1 shrink-0 min-w-0" data-testid="server-header">
      <Avatar name={s.name} color={s.color} size={24} />
      <div className="min-w-0 shrink">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-fg truncate">{s.name}</span>
          <button className="text-fg-4 hover:text-fg-2" onClick={() => openEditor(s.id)} title="Edit server">
            <Pencil size={11} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-fg-3 whitespace-nowrap">
          <StatusDot state={state} size={6} />
          <span className={cn(state === "failed" && "text-danger")}>{label}</span>
          <span className="text-fg-4">·</span>
          <span className="font-mono truncate">
            {s.username}@{s.host}
            {s.port !== 22 ? `:${s.port}` : ""}
          </span>
          {status?.fingerprint && state === "connected" && (
            <span title={`Verified host key: ${status.fingerprint}`}>
              <ShieldCheck size={11} className="text-ok" />
            </span>
          )}
        </div>
      </div>
      <nav className="flex items-center gap-0.5 mx-auto overflow-x-auto min-w-0 [&::-webkit-scrollbar]:h-0" aria-label="Server tools">
        {pinned.map((k: ServerToolKind) => {
          const t = SERVER_TOOLS[k];
          if (!t) return null;
          const active = activeKind === k;
          return (
            <button
              key={k}
              onClick={(e) => void openTool(serverId, k, {}, k === "terminal" && (e.ctrlKey || e.shiftKey))}
              title={`${t.label}${t.shortcut ? ` (${t.shortcut})` : ""} — ${t.description}`}
              className={cn(
                "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] whitespace-nowrap transition-colors",
                active ? "bg-accent-soft text-accent font-medium" : "text-fg-3 hover:text-fg hover:bg-bg-3",
              )}
              data-testid={`tool-${k}`}
            >
              {t.icon(14)}
              <span className="hidden xl:inline">{t.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="flex items-center gap-1.5 shrink-0">
        {state === "connected" ? (
          <Button size="sm" variant="ghost" icon={<Unplug size={13} />} onClick={() => void disconnectServer(serverId)}>
            Disconnect
          </Button>
        ) : state === "connecting" || state === "reconnecting" ? (
          <Button size="sm" variant="ghost" loading>
            {state === "reconnecting" ? "Reconnecting" : "Connecting"}
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={state === "failed" ? <RefreshCw size={13} /> : <Plug size={13} />} onClick={() => void connectServer(serverId)} data-testid="connect-button">
            {state === "failed" ? "Retry" : "Connect"}
          </Button>
        )}
      </div>
    </div>
  );
}
