import { useMemo } from "react";
import { Download, FolderTree, LayoutDashboard, Plug, Plus, Radio, Server, SquareTerminal, Star, Terminal, Zap, Cable, Keyboard } from "lucide-react";
import type { ServerProfile } from "@/types/generated";
import { useServers } from "@/stores/servers";
import { useTransfers, useTunnels } from "@/stores/data";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Sparkline } from "@/components/Charts";
import { Avatar, Button, Kbd, StatusDot } from "@/components/ui";
import { openMenu } from "@/components/ContextMenu";
import { cn, formatPercent, relativeTime } from "@/lib/format";
import { connectServer, openTool, serverMenu } from "../servers/actions";

function ServerCard({ s }: { s: ServerProfile }) {
  const status = useServers((st) => st.statuses[s.id]);
  const m = useServers((st) => st.metrics[s.id]);
  const spark = useServers((st) => st.spark[s.id]);
  const state = status?.state.state ?? "disconnected";
  const mem = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : null;
  const disk = m?.disks[0] ? (m.disks[0].usedBytes / Math.max(1, m.disks[0].totalBytes)) * 100 : null;
  return (
    <div
      className="group rounded-xl border border-line bg-bg-2 hover:border-line-2 hover:bg-bg-3/40 transition-colors p-4 flex flex-col gap-3 cursor-default"
      onDoubleClick={() => void openTool(s.id, "terminal")}
      onContextMenu={(e) => openMenu(e, serverMenu(s))}
      data-testid="server-card"
    >
      <div className="flex items-center gap-3">
        <Avatar name={s.name} color={s.color} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-semibold text-fg truncate">{s.name}</span>
            {s.favorite && <Star size={11} className="text-warn fill-warn" />}
          </div>
          <div className="text-[11.5px] text-fg-3 font-mono truncate">
            {s.username}@{s.host}
            {s.port !== 22 ? `:${s.port}` : ""}
          </div>
        </div>
        <StatusDot state={state} size={9} />
      </div>
      {state === "connected" && m ? (
        <div className="grid grid-cols-3 gap-2">
          {[
            { l: "CPU", v: m.cpuPercent, vals: spark?.cpu ?? [], c: "var(--accent)" },
            { l: "RAM", v: mem ?? 0, vals: spark?.mem ?? [], c: "var(--info)" },
            { l: "Disk", v: disk ?? 0, vals: [], c: "var(--ok)" },
          ].map((x) => (
            <div key={x.l} className="rounded-lg bg-bg-1 border border-line px-2.5 py-2">
              <div className="flex items-center justify-between text-[10.5px] text-fg-3 uppercase tracking-wider">
                {x.l}
                <span className={cn("tabular normal-case text-[11.5px] font-semibold", x.v > 90 ? "text-danger" : x.v > 75 ? "text-warn" : "text-fg")}>{formatPercent(x.v)}</span>
              </div>
              {x.vals.length > 1 ? <Sparkline values={x.vals} color={x.c} width={90} height={20} className="mt-1 w-full" /> : <div className="mt-2 h-1.5 rounded-full bg-bg-4 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${x.v}%`, background: x.c }} /></div>}
            </div>
          ))}
        </div>
      ) : (
        <div className="h-[58px] rounded-lg bg-bg-1 border border-line border-dashed flex items-center justify-center text-[12px] text-fg-3">
          {state === "connecting" || state === "reconnecting" ? "Connecting…" : state === "failed" ? <span className="text-danger/90 px-2 truncate">{(status!.state as { error: { message: string } }).error.message}</span> : `Last connected ${relativeTime(s.lastConnectedAt)}`}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        {state === "connected" ? (
          <>
            <Button size="xs" variant="primary" icon={<Terminal size={11} />} onClick={() => void openTool(s.id, "terminal", {}, true)}>
              Terminal
            </Button>
            <Button size="xs" variant="ghost" icon={<FolderTree size={11} />} onClick={() => void openTool(s.id, "files")}>
              Files
            </Button>
            <Button size="xs" variant="ghost" icon={<LayoutDashboard size={11} />} onClick={() => void openTool(s.id, "overview")}>
              Overview
            </Button>
          </>
        ) : (
          <Button size="xs" variant="secondary" icon={<Plug size={11} />} loading={state === "connecting"} onClick={() => void connectServer(s.id)}>
            Connect
          </Button>
        )}
        <span className="flex-1" />
        {s.tags.slice(0, 2).map((t) => (
          <span key={t} className="text-[10.5px] px-1.5 h-[18px] inline-flex items-center rounded bg-bg-4 text-fg-3">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+K", "Command palette"],
  ["Ctrl+P", "Quick server search"],
  ["Ctrl+Shift+T", "New terminal"],
  ["Ctrl+Shift+F", "File manager"],
  ["Ctrl+Shift+D", "Split terminal right"],
  ["Ctrl+Shift+L", "Local terminal"],
  ["Ctrl+Tab", "Next tab"],
  ["Ctrl+F4", "Close tab"],
];

export function HomeView() {
  const servers = useServers((s) => s.servers);
  const statuses = useServers((s) => s.statuses);
  const ui = useUi();
  const ws = useWorkspace((s) => s.workspaces.find((w) => w.id === s.currentId));
  const transfers = useTransfers((s) => s.items);
  const tunnels = useTunnels((s) => s.statuses);
  const list = useMemo(() => {
    const base = ws?.serverIds.length ? servers.filter((s) => ws.serverIds.includes(s.id)) : servers;
    return [...base].sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
  }, [servers, ws]);
  const connected = Object.values(statuses).filter((s) => s.state.state === "connected").length;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  if (!servers.length)
    return (
      <div className="h-full overflow-auto flex items-center justify-center p-8">
        <div className="max-w-[640px] w-full text-center anim-slide-up">
          <img src="/logo.svg" alt="" className="h-16 w-16 mx-auto mb-5 drop-shadow-[0_8px_30px_rgba(124,92,255,0.45)]" />
          <h1 className="text-[26px] font-semibold text-fg tracking-tight">Welcome to Brainbox VPS</h1>
          <p className="text-[14px] text-fg-3 mt-2 leading-relaxed">Your entire server workstation: terminals, files, editor, monitoring, Docker, services, logs and tunnels — in one place.</p>
          <div className="flex justify-center gap-2 mt-7">
            <Button size="lg" variant="primary" icon={<Plus size={16} />} onClick={() => ui.openServerEditor(null)} data-testid="welcome-add-server">
              Add your first server
            </Button>
            <Button size="lg" icon={<Download size={16} />} onClick={() => ui.set({ importOpen: true })}>
              Import ~/.ssh/config
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-10 text-left">
            {[
              { i: <Terminal size={16} />, t: "Real terminals", d: "Tabs, splits, tmux sessions that survive disconnects." },
              { i: <FolderTree size={16} />, t: "Drag & drop files", d: "Dual-pane SFTP with resumable transfers." },
              { i: <Radio size={16} />, t: "Many servers at once", d: "Broadcast commands and compare results." },
            ].map((x) => (
              <div key={x.t} className="rounded-xl border border-line bg-bg-2 p-4">
                <div className="h-8 w-8 rounded-lg bg-accent-soft text-accent flex items-center justify-center mb-2">{x.i}</div>
                <div className="text-[13px] font-semibold text-fg">{x.t}</div>
                <div className="text-[12px] text-fg-3 mt-0.5">{x.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-[1400px] mx-auto p-6 space-y-6">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <h1 className="text-[22px] font-semibold text-fg tracking-tight">{greet}</h1>
            <p className="text-[13px] text-fg-3 mt-0.5">
              {connected} of {servers.length} servers connected · {Object.values(tunnels).filter((t) => t.state === "running").length} tunnels running · {Object.values(transfers).filter((t) => t.state === "running").length} transfers active
            </p>
          </div>
          <div className="flex-1" />
          <Button icon={<SquareTerminal size={14} />} onClick={() => useWorkspace.getState().openTab("local-terminal", null, {}, { newTab: true })}>
            Local terminal
          </Button>
          <Button icon={<Radio size={14} />} onClick={() => useWorkspace.getState().openTab("broadcast")}>
            Broadcast
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => ui.openServerEditor(null)}>
            Add server
          </Button>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3">
          {list.map((s) => (
            <ServerCard key={s.id} s={s} />
          ))}
          <button onClick={() => ui.openServerEditor(null)} className="rounded-xl border border-dashed border-line-2 hover:border-accent hover:bg-accent-softer text-fg-3 hover:text-accent min-h-[170px] flex flex-col items-center justify-center gap-2 transition-colors">
            <Server size={20} />
            <span className="text-[13px] font-medium">Add server</span>
          </button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="rounded-xl border border-line bg-bg-2 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-3 mb-3 flex items-center gap-1.5">
              <Keyboard size={12} /> Keyboard shortcuts
            </div>
            <div className="space-y-1.5">
              {SHORTCUTS.map(([k, l]) => (
                <div key={k} className="flex items-center justify-between text-[12.5px] text-fg-2">
                  {l}
                  <Kbd chord={k} />
                </div>
              ))}
            </div>
          </div>
          <button onClick={() => useWorkspace.getState().openTab("all-commands")} className="rounded-xl border border-line bg-bg-2 p-4 text-left hover:border-line-2 flex flex-col items-start justify-start">
            <Zap size={18} className="text-accent" />
            <div className="text-[13.5px] font-semibold text-fg mt-2">Command Center</div>
            <div className="text-[12px] text-fg-3 mt-0.5">Save deploys, restarts and log tails. Run them with one click or a shortcut.</div>
          </button>
          <button onClick={() => useWorkspace.getState().openTab("all-tunnels")} className="rounded-xl border border-line bg-bg-2 p-4 text-left hover:border-line-2 flex flex-col items-start justify-start">
            <Cable size={18} className="text-accent" />
            <div className="text-[13.5px] font-semibold text-fg mt-2">SSH Tunnels</div>
            <div className="text-[12px] text-fg-3 mt-0.5">Reach databases and admin panels securely, expose local ports, or browse through a SOCKS proxy.</div>
          </button>
        </div>
      </div>
    </div>
  );
}
