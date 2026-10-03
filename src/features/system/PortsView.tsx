import { useMemo, useState } from "react";
import { Activity, Cable, Globe, Lock, RefreshCw, Terminal } from "lucide-react";
import type { PortInfo } from "@/types/generated";
import { api } from "@/services/api";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { useAsync } from "@/hooks/useAsync";
import { DataTable, type Column } from "@/components/DataTable";
import { openMenu } from "@/components/ContextMenu";
import { Badge, EmptyState, IconButton, SearchInput, Segmented, Spinner, Toolbar } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorView";
import { ConnectGate } from "../servers/ConnectGate";
import { openTool } from "../servers/actions";
import { editTunnel } from "../tunnels/TunnelsView";
import { leaf } from "@/stores/workspace";

const isPublic = (p: PortInfo) => ["0.0.0.0", "*", "::", "[::]"].includes(p.localAddress);

function Ports({ serverId }: { serverId: string }) {
  const list = useAsync(() => api.portsList(serverId), [serverId]);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "public" | "local">("all");
  const rows = useMemo(
    () =>
      (list.data ?? []).filter((p) => {
        if (scope === "public" && !isPublic(p)) return false;
        if (scope === "local" && isPublic(p)) return false;
        const ql = q.toLowerCase();
        return !ql || String(p.port).includes(ql) || (p.process ?? "").toLowerCase().includes(ql) || p.localAddress.includes(ql);
      }),
    [list.data, q, scope],
  );
  const inspect = (p: PortInfo) => {
    const ws = useWorkspace.getState();
    ws.openTab("terminal", serverId, { layout: leaf({ kind: "ssh", serverId, command: `sudo ss -tulpn 'sport = :${p.port}'; echo; sudo lsof -i :${p.port} 2>/dev/null | head -20; exec $SHELL -l` }) }, { newTab: true });
  };
  const columns: Column<PortInfo>[] = [
    { key: "port", header: "Port", width: 80, align: "right", sort: (a, b) => a.port - b.port, render: (p) => <span className="text-fg font-semibold tabular">{p.port}</span> },
    { key: "proto", header: "Protocol", width: 80, render: (p) => <span className="uppercase text-[11.5px] text-fg-3">{p.protocol}</span> },
    { key: "addr", header: "Address", width: 180, sort: (a, b) => a.localAddress.localeCompare(b.localAddress), render: (p) => <span className="font-mono text-[12px]">{p.localAddress}</span> },
    {
      key: "exposure",
      header: "Exposure",
      width: 110,
      render: (p) =>
        isPublic(p) ? (
          <Badge tone="warn">
            <Globe size={10} /> Public
          </Badge>
        ) : (
          <Badge tone="ok">
            <Lock size={10} /> Local
          </Badge>
        ),
    },
    { key: "proc", header: "Process", width: "minmax(140px,1fr)", sort: (a, b) => (a.process ?? "").localeCompare(b.process ?? ""), render: (p) => (p.process ? <span className="text-fg">{p.process}</span> : <span className="text-fg-4" title="Process names of other users require sudo">unknown</span>) },
    { key: "pid", header: "PID", width: 80, align: "right", sort: (a, b) => (a.pid ?? 0) - (b.pid ?? 0), render: (p) => (p.pid != null ? <button className="text-accent hover:underline tabular" onClick={(e) => (e.stopPropagation(), void openTool(serverId, "processes", { filterPid: p.pid }))}>{p.pid}</button> : "—") },
    { key: "state", header: "State", width: 90, render: (p) => <span className="text-fg-3 text-[11.5px]">{p.state}</span> },
  ];
  if (list.error && !list.data) return <ErrorPanel error={list.error} onRetry={() => void list.reload()} />;
  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Filter by port or process" className="w-64" />
        <Segmented value={scope} onChange={setScope} options={[{ value: "all", label: "All" }, { value: "public", label: "Public" }, { value: "local", label: "Local only" }]} />
        <span className="text-[12px] text-fg-3">{rows.length} listening</span>
        <div className="flex-1" />
        <IconButton label="Refresh" onClick={() => void list.reload()}>
          <RefreshCw size={14} className={list.loading ? "anim-spin" : ""} />
        </IconButton>
      </Toolbar>
      {list.initial ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(p) => `${p.protocol}:${p.localAddress}:${p.port}`}
          initialSort={{ key: "port" }}
          onRowDoubleClick={inspect}
          onRowContextMenu={(p, e) =>
            openMenu(e, [
              { type: "header", label: `${p.protocol.toUpperCase()} ${p.port}` },
              { label: "View process", icon: <Activity size={14} />, disabled: p.pid == null, onClick: () => void openTool(serverId, "processes", { filterPid: p.pid }) },
              { label: "Inspect in terminal", icon: <Terminal size={14} />, onClick: () => inspect(p) },
              { label: "Forward to this PC…", icon: <Cable size={14} />, disabled: p.protocol !== "tcp", onClick: () => void editTunnel(null, { serverId, kind: "local", name: `${p.process ?? "port"} ${p.port}`, bindHost: "127.0.0.1", bindPort: p.port < 1024 ? p.port + 8000 : p.port, targetHost: isPublic(p) ? "127.0.0.1" : p.localAddress, targetPort: p.port, autoStart: false }) },
            ])
          }
          empty={<EmptyState title="No listening ports" />}
        />
      )}
    </div>
  );
}

export function PortsView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="see listening ports">
      <Ports serverId={tab.serverId!} />
    </ConnectGate>
  );
}
