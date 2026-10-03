import { useEffect, useMemo, useState } from "react";
import { platform } from "@/services/platform";
import { Activity, Info, OctagonX, RefreshCw, Skull, TerminalSquare, Pause, Play } from "lucide-react";
import type { ProcessInfo, Signal } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { toastError, useUi } from "@/stores/ui";
import { leaf, useWorkspace, type Tab } from "@/stores/workspace";
import { useAsync, useInterval } from "@/hooks/useAsync";
import { DataTable, type Column } from "@/components/DataTable";
import { openMenu } from "@/components/ContextMenu";
import { Button, EmptyState, IconButton, SearchInput, Spinner, Toolbar } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorView";
import { Modal } from "@/components/Modal";
import { cn, formatBytes, formatDuration } from "@/lib/format";
import { ConnectGate } from "../servers/ConnectGate";
import { withSudo } from "../servers/actions";

function Bar({ v, max = 100, color }: { v: number; max?: number; color: string }) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <span className="tabular w-11 text-right">{v.toFixed(1)}</span>
      <div className="w-12 h-1 rounded-full bg-bg-4 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }} />
      </div>
    </div>
  );
}

async function signal(serverId: string, p: ProcessInfo, sig: Signal, reload: () => void) {
  const kill = sig === "kill";
  const ok = await useUi.getState().confirm({
    title: `${kill ? "Force kill" : "Terminate"} ${p.name} (PID ${p.pid})?`,
    message: kill ? "SIGKILL stops the process immediately without letting it clean up. Unsaved data may be lost." : "SIGTERM asks the process to shut down gracefully.",
    command: `kill -${kill ? "KILL" : "TERM"} ${p.pid}   # ${p.command.slice(0, 120)}`,
    confirmLabel: kill ? "Force kill" : "Terminate",
    danger: true,
    details: p.user === "root" ? ["This process runs as root — stopping it may affect the whole server"] : undefined,
  });
  if (!ok) return;
  try {
    await withSudo(serverId, (pw) => api.processSignal(serverId, p.pid, sig, true, pw));
    useUi.getState().toast({ kind: "success", title: `Sent SIG${kill ? "KILL" : "TERM"} to ${p.pid}` });
    setTimeout(reload, 600);
  } catch (e) {
    const err = toAppError(e);
    if (err.code !== "cancelled") toastError(err);
  }
}

function Details({ serverId, p, onClose }: { serverId: string; p: ProcessInfo; onClose: () => void }) {
  const d = useAsync(() => api.processDetails(serverId, p.pid), [p.pid]);
  return (
    <Modal open onClose={onClose} title={`${p.name} · PID ${p.pid}`} icon={<Info size={18} />} width={640} footer={<Button onClick={onClose}>Close</Button>}>
      {d.loading ? <Spinner /> : d.error ? <div className="text-danger text-[13px]">{d.error.message}</div> : <pre className="text-[12px] font-mono text-fg-2 whitespace-pre-wrap break-all bg-bg-0 border border-line rounded-md p-3 max-h-[50vh] overflow-auto selectable">{d.data}</pre>}
    </Modal>
  );
}

function Processes({ serverId, filterPid }: { serverId: string; filterPid?: number }) {
  const list = useAsync(() => api.processesList(serverId), [serverId]);
  const [q, setQ] = useState(filterPid ? String(filterPid) : "");
  const [auto, setAuto] = useState(true);
  const [sel, setSel] = useState<number | null>(filterPid ?? null);
  const ui = useUi();
  useInterval(() => void list.reload(), auto ? 4000 : null);
  useEffect(() => {
    if (filterPid) setQ(String(filterPid));
  }, [filterPid]);

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (list.data ?? []).filter((p) => !ql || String(p.pid) === ql || p.name.toLowerCase().includes(ql) || p.command.toLowerCase().includes(ql) || p.user.toLowerCase().includes(ql));
  }, [list.data, q]);

  const details = (p: ProcessInfo) => void ui.custom((close) => <Details serverId={serverId} p={p} onClose={() => close()} />);
  const columns: Column<ProcessInfo>[] = [
    { key: "pid", header: "PID", width: 70, align: "right", sort: (a, b) => a.pid - b.pid, render: (p) => <span className="text-fg-3">{p.pid}</span> },
    { key: "name", header: "Name", width: "minmax(130px,1fr)", sort: (a, b) => a.name.localeCompare(b.name), render: (p) => <span className="text-fg font-medium">{p.name}</span> },
    { key: "cpu", header: "CPU %", width: 110, align: "right", sort: (a, b) => a.cpuPercent - b.cpuPercent, render: (p) => <Bar v={p.cpuPercent} color={p.cpuPercent > 80 ? "var(--danger)" : "var(--accent)"} /> },
    { key: "mem", header: "Mem %", width: 110, align: "right", sort: (a, b) => a.memPercent - b.memPercent, render: (p) => <Bar v={p.memPercent} color="var(--info)" /> },
    { key: "rss", header: "RSS", width: 84, align: "right", sort: (a, b) => a.rssKb - b.rssKb, render: (p) => formatBytes(p.rssKb * 1024) },
    { key: "user", header: "User", width: 90, sort: (a, b) => a.user.localeCompare(b.user), render: (p) => <span className={cn(p.user === "root" && "text-warn")}>{p.user}</span> },
    { key: "state", header: "Status", width: 64, render: (p) => <span className="font-mono text-[11.5px]" title="R running · S sleeping · D disk wait · Z zombie · T stopped">{p.state}</span> },
    { key: "time", header: "Uptime", width: 80, align: "right", sort: (a, b) => a.elapsedSecs - b.elapsedSecs, render: (p) => <span className="text-fg-3">{formatDuration(p.elapsedSecs)}</span> },
    { key: "cmd", header: "Command", width: "minmax(200px,2.4fr)", render: (p) => <span className="font-mono text-[11.5px] text-fg-3" title={p.command}>{p.command}</span> },
  ];

  if (list.error && !list.data) return <ErrorPanel error={list.error} onRetry={() => void list.reload()} />;
  const selected = rows.find((r) => r.pid === sel);
  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Filter by name, PID, user, command" className="w-80" />
        <span className="text-[12px] text-fg-3 ml-1">{rows.length} processes</span>
        <div className="flex-1" />
        {selected && (
          <>
            <Button size="sm" variant="ghost" icon={<Info size={13} />} onClick={() => details(selected)}>
              Details
            </Button>
            <Button size="sm" variant="ghost" icon={<OctagonX size={13} />} onClick={() => void signal(serverId, selected, "term", list.reload)}>
              Terminate
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" icon={<Skull size={13} />} onClick={() => void signal(serverId, selected, "kill", list.reload)}>
              Kill
            </Button>
            <div className="w-px h-5 bg-line" />
          </>
        )}
        <IconButton label={auto ? "Pause auto-refresh" : "Resume auto-refresh"} active={auto} onClick={() => setAuto(!auto)}>
          {auto ? <Pause size={14} /> : <Play size={14} />}
        </IconButton>
        <IconButton label="Refresh" onClick={() => void list.reload()}>
          <RefreshCw size={14} className={list.loading ? "anim-spin" : ""} />
        </IconButton>
        <Button size="sm" variant="ghost" icon={<TerminalSquare size={13} />} onClick={() => useWorkspace.getState().openTab("terminal", serverId, { layout: leaf({ kind: "ssh", serverId, command: "htop 2>/dev/null || top" }) }, { newTab: true })} title="Open htop (or top) in a terminal">
          htop
        </Button>
      </Toolbar>
      {list.initial ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(p) => String(p.pid)}
          initialSort={{ key: "cpu", desc: true }}
          selected={sel != null ? String(sel) : null}
          onRowClick={(p) => setSel(p.pid)}
          onRowDoubleClick={details}
          onRowContextMenu={(p, e) => {
            setSel(p.pid);
            openMenu(e, [
              { type: "header", label: `${p.name} · ${p.pid}` },
              { label: "Details", icon: <Info size={14} />, onClick: () => details(p) },
              { label: "Copy command", icon: <Activity size={14} />, onClick: () => void platform.writeClipboard(p.command) },
              { type: "separator" },
              { label: "Terminate (SIGTERM)", icon: <OctagonX size={14} />, onClick: () => void signal(serverId, p, "term", list.reload) },
              { label: "Reload config (SIGHUP)", onClick: () => void signal(serverId, p, "hup", list.reload) },
              { label: "Kill (SIGKILL)", icon: <Skull size={14} />, danger: true, onClick: () => void signal(serverId, p, "kill", list.reload) },
            ]);
          }}
          empty={<EmptyState title="No matching processes" />}
        />
      )}
    </div>
  );
}

export function ProcessesView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="see processes">
      <Processes serverId={tab.serverId!} filterPid={tab.data.filterPid} />
    </ConnectGate>
  );
}
