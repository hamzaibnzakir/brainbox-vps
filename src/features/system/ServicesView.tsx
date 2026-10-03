import { useMemo, useState } from "react";
import { FileText, Info, Play, Power, PowerOff, RefreshCw, RotateCcw, ScrollText, Square } from "lucide-react";
import type { ServiceAction, ServiceInfo } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { toastError, useUi } from "@/stores/ui";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { useAsync } from "@/hooks/useAsync";
import { DataTable, type Column } from "@/components/DataTable";
import { openMenu, type MenuItem } from "@/components/ContextMenu";
import { Badge, Button, EmptyState, IconButton, SearchInput, Segmented, Spinner, Toolbar } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorView";
import { Modal } from "@/components/Modal";
import { ConnectGate } from "../servers/ConnectGate";
import { withSudo } from "../servers/actions";

type Filter = "all" | "running" | "failed" | "enabled" | "inactive";

const CRITICAL = /^(ssh|sshd|networking|systemd-networkd|NetworkManager|systemd-resolved|dbus)\.service$/;

export async function runServiceAction(serverId: string, unit: string, action: ServiceAction, after?: () => void) {
  const verbs: Record<ServiceAction, string> = { start: "Start", stop: "Stop", restart: "Restart", reload: "Reload", enable: "Enable", disable: "Disable" };
  const critical = CRITICAL.test(unit) && (action === "stop" || action === "disable" || action === "restart");
  const ok = await useUi.getState().confirm({
    title: `${verbs[action]} ${unit}?`,
    message:
      action === "stop" ? "The service will stop until it is started again." : action === "restart" ? "The service restarts; it may be briefly unavailable." : action === "disable" ? "The service will no longer start at boot." : action === "enable" ? "The service will start automatically at boot." : undefined,
    command: `sudo systemctl ${action} ${unit}`,
    confirmLabel: verbs[action],
    danger: action === "stop" || action === "disable" || critical,
    details: critical ? ["This service is required for remote access — you may lock yourself out of the server."] : undefined,
    requireText: critical ? unit.replace(".service", "") : undefined,
  });
  if (!ok) return;
  const id = useUi.getState().toast({ kind: "info", title: `${verbs[action]}ing ${unit}…`, timeout: 0 });
  try {
    await withSudo(serverId, (pw) => api.serviceAction(serverId, unit, action, true, pw));
    useUi.getState().dismissToast(id);
    useUi.getState().toast({ kind: "success", title: `${unit}: ${action} done` });
    after?.();
  } catch (e) {
    useUi.getState().dismissToast(id);
    const err = toAppError(e);
    if (err.code !== "cancelled") toastError(err);
  }
}

function StatusDialog({ serverId, unit, onClose }: { serverId: string; unit: string; onClose: () => void }) {
  const st = useAsync(() => api.serviceStatus(serverId, unit), [unit]);
  return (
    <Modal open onClose={onClose} title={unit} subtitle="systemctl status" icon={<Info size={18} />} width={720} footer={<Button onClick={onClose}>Close</Button>}>
      {st.loading ? <Spinner /> : <pre className="text-[12px] font-mono text-fg-2 whitespace-pre-wrap break-all bg-bg-0 border border-line rounded-md p-3 max-h-[55vh] overflow-auto selectable">{st.data ?? st.error?.message}</pre>}
    </Modal>
  );
}

function stateBadge(s: ServiceInfo) {
  if (s.activeState === "active" && s.subState === "running") return <Badge tone="ok">running</Badge>;
  if (s.activeState === "active") return <Badge tone="info">{s.subState}</Badge>;
  if (s.activeState === "failed") return <Badge tone="danger">failed</Badge>;
  if (s.activeState === "activating" || s.activeState === "deactivating") return <Badge tone="warn">{s.activeState}</Badge>;
  return <Badge>{s.activeState}</Badge>;
}

function Services({ serverId }: { serverId: string }) {
  const list = useAsync(() => api.servicesList(serverId), [serverId]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const ui = useUi();
  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    return (list.data ?? []).filter((s) => {
      if (ql && !s.name.toLowerCase().includes(ql) && !s.description.toLowerCase().includes(ql)) return false;
      if (filter === "running") return s.subState === "running";
      if (filter === "failed") return s.activeState === "failed";
      if (filter === "enabled") return s.enabledState === "enabled";
      if (filter === "inactive") return s.activeState === "inactive";
      return true;
    });
  }, [list.data, q, filter]);
  const failed = (list.data ?? []).filter((s) => s.activeState === "failed").length;

  const act = (unit: string, a: ServiceAction) => void runServiceAction(serverId, unit, a, () => void list.reload());
  const logs = (unit: string) => useWorkspace.getState().openTab("logs", serverId, { source: { kind: "service", unit } });
  const status = (unit: string) => void ui.custom((close) => <StatusDialog serverId={serverId} unit={unit} onClose={() => close()} />);
  const menu = (s: ServiceInfo): MenuItem[] => [
    { type: "header", label: s.name },
    { label: "Start", icon: <Play size={14} />, disabled: s.activeState === "active", onClick: () => act(s.name, "start") },
    { label: "Restart", icon: <RotateCcw size={14} />, onClick: () => act(s.name, "restart") },
    { label: "Reload", icon: <RefreshCw size={14} />, disabled: s.activeState !== "active", onClick: () => act(s.name, "reload") },
    { label: "Stop", icon: <Square size={14} />, danger: true, disabled: s.activeState !== "active", onClick: () => act(s.name, "stop") },
    { type: "separator" },
    { label: "Enable at boot", icon: <Power size={14} />, disabled: s.enabledState === "enabled", onClick: () => act(s.name, "enable") },
    { label: "Disable at boot", icon: <PowerOff size={14} />, disabled: s.enabledState !== "enabled", onClick: () => act(s.name, "disable") },
    { type: "separator" },
    { label: "View logs", icon: <ScrollText size={14} />, onClick: () => logs(s.name) },
    { label: "Status", icon: <FileText size={14} />, onClick: () => status(s.name) },
  ];

  const columns: Column<ServiceInfo>[] = [
    { key: "name", header: "Service", width: "minmax(180px,1fr)", sort: (a, b) => a.name.localeCompare(b.name), render: (s) => <span className="text-fg font-medium">{s.name.replace(/\.service$/, "")}</span> },
    { key: "state", header: "Status", width: 110, sort: (a, b) => a.activeState.localeCompare(b.activeState), render: stateBadge },
    { key: "enabled", header: "At boot", width: 100, sort: (a, b) => a.enabledState.localeCompare(b.enabledState), render: (s) => <span className={s.enabledState === "enabled" ? "text-fg-2" : "text-fg-4"}>{s.enabledState}</span> },
    { key: "desc", header: "Description", width: "minmax(200px,2fr)", render: (s) => <span className="text-fg-3">{s.description}</span> },
    {
      key: "actions",
      header: "",
      width: 120,
      align: "right",
      render: (s) => (
        <span className="flex justify-end gap-0.5 opacity-70 hover:opacity-100" onClick={(e) => e.stopPropagation()}>
          {s.activeState === "active" ? (
            <IconButton label="Restart" size="xs" onClick={() => act(s.name, "restart")}>
              <RotateCcw size={12} />
            </IconButton>
          ) : (
            <IconButton label="Start" size="xs" onClick={() => act(s.name, "start")}>
              <Play size={12} />
            </IconButton>
          )}
          {s.activeState === "active" && (
            <IconButton label="Stop" size="xs" tone="danger" onClick={() => act(s.name, "stop")}>
              <Square size={12} />
            </IconButton>
          )}
          <IconButton label="Logs" size="xs" onClick={() => logs(s.name)}>
            <ScrollText size={12} />
          </IconButton>
        </span>
      ),
    },
  ];

  if (list.error && !list.data) return <ErrorPanel error={list.error} onRetry={() => void list.reload()} />;
  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Filter services" className="w-64" />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "running", label: "Running" },
            { value: "failed", label: <>Failed{failed > 0 && <span className="ml-1 text-danger">{failed}</span>}</> },
            { value: "enabled", label: "Enabled" },
            { value: "inactive", label: "Inactive" },
          ]}
        />
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
        <DataTable rows={rows} columns={columns} rowKey={(s) => s.name} selected={sel} onRowClick={(s) => setSel(s.name)} onRowDoubleClick={(s) => status(s.name)} onRowContextMenu={(s, e) => (setSel(s.name), openMenu(e, menu(s)))} initialSort={{ key: "name" }} empty={<EmptyState title="No matching services" />} />
      )}
    </div>
  );
}

export function ServicesView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="manage services">
      <Services serverId={tab.serverId!} />
    </ConnectGate>
  );
}
