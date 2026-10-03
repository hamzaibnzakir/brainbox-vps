import { useMemo, useState } from "react";
import { Box, FileSearch, HardDrive, Layers, Network, Pause, Play, RefreshCw, RotateCcw, ScrollText, Square, SquareTerminal, Trash2, Container as ContainerIcon, Activity } from "lucide-react";
import type { ContainerAction, DockerContainer, DockerImage, DockerStats, DockerVolume } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { toastError, useUi } from "@/stores/ui";
import { leaf, useWorkspace, type Tab } from "@/stores/workspace";
import { useAsync, useInterval } from "@/hooks/useAsync";
import { DataTable, type Column } from "@/components/DataTable";
import { openMenu, type MenuItem } from "@/components/ContextMenu";
import { Badge, Button, EmptyState, IconButton, SearchInput, Segmented, Spinner, Toolbar } from "@/components/ui";
import { ErrorPanel, ErrorView } from "@/components/ErrorView";
import { Modal } from "@/components/Modal";
import { ConnectGate } from "../servers/ConnectGate";

type View = "containers" | "images" | "volumes" | "networks";

function stateBadge(c: DockerContainer) {
  const t = c.state === "running" ? "ok" : c.state === "paused" ? "warn" : c.state === "restarting" ? "info" : c.state === "dead" ? "danger" : "neutral";
  return <Badge tone={t}>{c.state}</Badge>;
}

const LABELS: Record<ContainerAction, string> = { start: "Start", stop: "Stop", restart: "Restart", pause: "Pause", unpause: "Resume", remove: "Remove" };

async function containerAction(serverId: string, c: DockerContainer, a: ContainerAction, after: () => void) {
  const destructive = a === "remove" || a === "stop";
  const ok = await useUi.getState().confirm({
    title: `${LABELS[a]} ${c.name}?`,
    message: a === "remove" ? "The container is deleted (force). Its writable layer is lost; named volumes are kept." : a === "stop" ? "Processes in the container are stopped." : undefined,
    command: `docker ${a === "remove" ? "rm -f" : a} ${c.name}`,
    confirmLabel: LABELS[a],
    danger: destructive,
    details: c.composeProject && a === "remove" ? [`Part of compose project “${c.composeProject}” — \`docker compose up\` would recreate it`] : undefined,
  });
  if (!ok) return;
  try {
    await api.dockerContainerAction(serverId, c.id, a, true);
    useUi.getState().toast({ kind: "success", title: `${c.name}: ${LABELS[a].toLowerCase()} done` });
  } catch (e) {
    toastError(toAppError(e));
  }
  after();
}

function Inspect({ serverId, id, name, onClose }: { serverId: string; id: string; name: string; onClose: () => void }) {
  const d = useAsync(() => api.dockerInspect(serverId, id), [id]);
  return (
    <Modal open onClose={onClose} title={`Inspect ${name}`} icon={<FileSearch size={18} />} width={820} footer={<Button onClick={onClose}>Close</Button>}>
      {d.loading ? <Spinner /> : <pre className="text-[11.5px] font-mono text-fg-2 whitespace-pre bg-bg-0 border border-line rounded-md p-3 max-h-[60vh] overflow-auto selectable">{d.data ?? d.error?.message}</pre>}
    </Modal>
  );
}

function Containers({ serverId }: { serverId: string }) {
  const list = useAsync(() => api.dockerContainers(serverId), [serverId]);
  const stats = useAsync(() => api.dockerStats(serverId), [serverId]);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [onlyRunning, setOnlyRunning] = useState(false);
  const ui = useUi();
  useInterval(() => {
    void list.reload();
    void stats.reload();
  }, 6000);
  const statsBy = useMemo(() => new Map((stats.data ?? []).map((s: DockerStats) => [s.name, s])), [stats.data]);
  const rows = useMemo(() => (list.data ?? []).filter((c) => (!onlyRunning || c.state === "running") && (!q || `${c.name} ${c.image} ${c.composeProject ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [list.data, q, onlyRunning]);
  const reload = () => {
    void list.reload();
    void stats.reload();
  };
  const shell = async (c: DockerContainer) => {
    try {
      const cmd = await api.dockerExecCommand(serverId, c.id);
      useWorkspace.getState().openTab("terminal", serverId, { layout: leaf({ kind: "ssh", serverId, command: cmd, title: c.name }) }, { newTab: true });
    } catch (e) {
      toastError(toAppError(e));
    }
  };
  const logs = (c: DockerContainer) => useWorkspace.getState().openTab("logs", serverId, { source: { kind: "docker", container: c.name } });
  const inspect = (c: DockerContainer) => void ui.custom((close) => <Inspect serverId={serverId} id={c.id} name={c.name} onClose={() => close()} />);
  const menu = (c: DockerContainer): MenuItem[] => {
    const running = c.state === "running";
    return [
      { type: "header", label: c.name },
      ...(running
        ? ([
            { label: "Open shell", icon: <SquareTerminal size={14} />, onClick: () => void shell(c) },
            { label: "Restart", icon: <RotateCcw size={14} />, onClick: () => void containerAction(serverId, c, "restart", reload) },
            { label: "Pause", icon: <Pause size={14} />, onClick: () => void containerAction(serverId, c, "pause", reload) },
            { label: "Stop", icon: <Square size={14} />, danger: true, onClick: () => void containerAction(serverId, c, "stop", reload) },
          ] as MenuItem[])
        : c.state === "paused"
          ? ([{ label: "Resume", icon: <Play size={14} />, onClick: () => void containerAction(serverId, c, "unpause", reload) }] as MenuItem[])
          : ([{ label: "Start", icon: <Play size={14} />, onClick: () => void containerAction(serverId, c, "start", reload) }] as MenuItem[])),
      { type: "separator" },
      { label: "Logs (live)", icon: <ScrollText size={14} />, onClick: () => logs(c) },
      { label: "Inspect", icon: <FileSearch size={14} />, onClick: () => inspect(c) },
      { type: "separator" },
      { label: "Remove…", icon: <Trash2 size={14} />, danger: true, onClick: () => void containerAction(serverId, c, "remove", reload) },
    ];
  };
  const columns: Column<DockerContainer>[] = [
    {
      key: "name",
      header: "Container",
      width: "minmax(160px,1.3fr)",
      sort: (a, b) => a.name.localeCompare(b.name),
      render: (c) => (
        <span className="flex items-center gap-2 min-w-0">
          <ContainerIcon size={14} className={c.state === "running" ? "text-ok" : "text-fg-4"} />
          <span className="truncate text-fg font-medium">{c.name}</span>
          {c.composeProject && <span className="text-[10.5px] text-fg-4 truncate">· {c.composeProject}</span>}
        </span>
      ),
    },
    { key: "state", header: "State", width: 96, sort: (a, b) => a.state.localeCompare(b.state), render: stateBadge },
    { key: "image", header: "Image", width: "minmax(140px,1fr)", sort: (a, b) => a.image.localeCompare(b.image), render: (c) => <span className="font-mono text-[11.5px] text-fg-3">{c.image}</span> },
    { key: "cpu", header: "CPU", width: 70, align: "right", render: (c) => <span className="tabular">{statsBy.get(c.name)?.cpuPercent ?? "—"}</span> },
    { key: "mem", header: "Memory", width: 120, align: "right", render: (c) => <span className="tabular text-fg-3">{statsBy.get(c.name)?.memUsage.split(" / ")[0] ?? "—"}</span> },
    { key: "ports", header: "Ports", width: "minmax(120px,1fr)", render: (c) => <span className="font-mono text-[11px] text-fg-3" title={c.ports}>{c.ports || "—"}</span> },
    { key: "status", header: "Status", width: 150, render: (c) => <span className="text-fg-3">{c.status}</span> },
    {
      key: "act",
      header: "",
      width: 132,
      align: "right",
      render: (c) => (
        <span className="flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          {c.state === "running" ? (
            <>
              <IconButton label="Shell" size="xs" onClick={() => void shell(c)}>
                <SquareTerminal size={12} />
              </IconButton>
              <IconButton label="Restart" size="xs" onClick={() => void containerAction(serverId, c, "restart", reload)}>
                <RotateCcw size={12} />
              </IconButton>
              <IconButton label="Stop" size="xs" tone="danger" onClick={() => void containerAction(serverId, c, "stop", reload)}>
                <Square size={12} />
              </IconButton>
            </>
          ) : (
            <IconButton label={c.state === "paused" ? "Resume" : "Start"} size="xs" onClick={() => void containerAction(serverId, c, c.state === "paused" ? "unpause" : "start", reload)}>
              <Play size={12} />
            </IconButton>
          )}
          <IconButton label="Logs" size="xs" onClick={() => logs(c)}>
            <ScrollText size={12} />
          </IconButton>
        </span>
      ),
    },
  ];
  if (list.error && !list.data) return <ErrorPanel error={list.error} onRetry={reload} />;
  const running = (list.data ?? []).filter((c) => c.state === "running").length;
  return (
    <>
      <Toolbar>
        <SearchInput value={q} onChange={setQ} placeholder="Filter containers" className="w-64" />
        <Button size="sm" variant={onlyRunning ? "subtle" : "ghost"} onClick={() => setOnlyRunning(!onlyRunning)}>
          Running only
        </Button>
        <span className="text-[12px] text-fg-3">
          {running} running · {(list.data ?? []).length} total
        </span>
        <div className="flex-1" />
        <IconButton label="Refresh" onClick={reload}>
          <RefreshCw size={14} className={list.loading ? "anim-spin" : ""} />
        </IconButton>
      </Toolbar>
      {list.initial ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : (
        <DataTable rows={rows} columns={columns} rowKey={(c) => c.id} selected={sel} onRowClick={(c) => setSel(c.id)} onRowDoubleClick={(c) => (c.state === "running" ? void shell(c) : inspect(c))} onRowContextMenu={(c, e) => (setSel(c.id), openMenu(e, menu(c)))} initialSort={{ key: "state", desc: true }} empty={<EmptyState icon={<Box size={20} />} title="No containers" />} />
      )}
    </>
  );
}

function Images({ serverId }: { serverId: string }) {
  const list = useAsync(() => api.dockerImages(serverId), [serverId]);
  const remove = async (i: DockerImage) => {
    if (!(await useUi.getState().confirm({ title: `Remove image ${i.repository}:${i.tag}?`, command: `docker rmi ${i.id}`, danger: true, confirmLabel: "Remove" }))) return;
    try {
      await api.dockerRemoveImage(serverId, i.id, true);
      void list.reload();
    } catch (e) {
      toastError(toAppError(e));
    }
  };
  const cols: Column<DockerImage>[] = [
    { key: "repo", header: "Repository", width: "minmax(180px,1.5fr)", sort: (a, b) => a.repository.localeCompare(b.repository), render: (i) => <span className="text-fg font-medium">{i.repository}</span> },
    { key: "tag", header: "Tag", width: 140, render: (i) => <Badge tone="accent">{i.tag}</Badge> },
    { key: "id", header: "ID", width: 140, render: (i) => <span className="font-mono text-[11.5px] text-fg-3">{i.id.replace("sha256:", "").slice(0, 12)}</span> },
    { key: "size", header: "Size", width: 100, align: "right", render: (i) => i.size },
    { key: "created", header: "Created", width: 140, render: (i) => <span className="text-fg-3">{i.created}</span> },
    { key: "a", header: "", width: 50, align: "right", render: (i) => <IconButton label="Remove" size="xs" tone="danger" onClick={(e) => (e.stopPropagation(), void remove(i))}><Trash2 size={12} /></IconButton> },
  ];
  if (list.error) return <ErrorPanel error={list.error} onRetry={() => void list.reload()} />;
  return list.initial ? <Spinner /> : <DataTable rows={list.data ?? []} columns={cols} rowKey={(i) => i.id + i.tag} empty={<EmptyState title="No images" />} />;
}

function Volumes({ serverId }: { serverId: string }) {
  const list = useAsync(() => api.dockerVolumes(serverId), [serverId]);
  const remove = async (v: DockerVolume) => {
    if (!(await useUi.getState().confirm({ title: `Delete volume ${v.name}?`, message: "All data stored in this volume is permanently deleted.", command: `docker volume rm ${v.name}`, danger: true, confirmLabel: "Delete volume", requireText: v.name }))) return;
    try {
      await api.dockerRemoveVolume(serverId, v.name, true);
      void list.reload();
    } catch (e) {
      toastError(toAppError(e));
    }
  };
  const cols: Column<DockerVolume>[] = [
    { key: "name", header: "Volume", width: "minmax(200px,1fr)", sort: (a, b) => a.name.localeCompare(b.name), render: (v) => <span className="text-fg font-medium flex items-center gap-2"><HardDrive size={13} className="text-fg-3" />{v.name}</span> },
    { key: "driver", header: "Driver", width: 100, render: (v) => v.driver },
    { key: "mount", header: "Mountpoint", width: "minmax(240px,2fr)", render: (v) => <span className="font-mono text-[11.5px] text-fg-3">{v.mountpoint}</span> },
    { key: "a", header: "", width: 50, align: "right", render: (v) => <IconButton label="Delete" size="xs" tone="danger" onClick={(e) => (e.stopPropagation(), void remove(v))}><Trash2 size={12} /></IconButton> },
  ];
  if (list.error) return <ErrorPanel error={list.error} onRetry={() => void list.reload()} />;
  return list.initial ? <Spinner /> : <DataTable rows={list.data ?? []} columns={cols} rowKey={(v) => v.name} empty={<EmptyState title="No volumes" />} />;
}

function Networks({ serverId }: { serverId: string }) {
  const list = useAsync(() => api.dockerNetworks(serverId), [serverId]);
  if (list.error) return <ErrorPanel error={list.error} onRetry={() => void list.reload()} />;
  return list.initial ? (
    <Spinner />
  ) : (
    <DataTable
      rows={list.data ?? []}
      rowKey={(n) => n.id}
      columns={[
        { key: "name", header: "Network", width: "minmax(180px,1fr)", render: (n) => <span className="text-fg font-medium flex items-center gap-2"><Network size={13} className="text-fg-3" />{n.name}</span> },
        { key: "driver", header: "Driver", width: 120, render: (n) => n.driver },
        { key: "scope", header: "Scope", width: 100, render: (n) => n.scope },
        { key: "id", header: "ID", width: 140, render: (n) => <span className="font-mono text-[11.5px] text-fg-3">{n.id.slice(0, 12)}</span> },
      ]}
    />
  );
}

function Docker({ serverId }: { serverId: string }) {
  const status = useAsync(() => api.dockerStatus(serverId, true), [serverId]);
  const [view, setView] = useState<View>("containers");
  if (status.initial)
    return (
      <div className="h-full flex items-center justify-center gap-2 text-fg-3 text-[13px]">
        <Spinner /> Detecting Docker…
      </div>
    );
  if (status.error) return <ErrorPanel error={status.error} onRetry={() => void status.reload()} />;
  if (!status.data?.available)
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-[560px] w-full space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-bg-3 border border-line flex items-center justify-center text-fg-3">
              <ContainerIcon size={18} />
            </div>
            <div>
              <div className="text-[14px] font-semibold text-fg">Docker isn't available on this server</div>
              <div className="text-[12.5px] text-fg-3">Brainbox will show containers, images and volumes as soon as Docker can be used.</div>
            </div>
          </div>
          {status.data?.reason && <ErrorView error={status.data.reason} actions={<Button size="sm" onClick={() => void status.reload()}>Check again</Button>} />}
        </div>
      </div>
    );
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 h-10 px-3 border-b border-line bg-bg-1 shrink-0">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "containers", label: <><ContainerIcon size={12} />Containers</> },
            { value: "images", label: <><Layers size={12} />Images</> },
            { value: "volumes", label: <><HardDrive size={12} />Volumes</> },
            { value: "networks", label: <><Network size={12} />Networks</> },
          ]}
        />
        <div className="flex-1" />
        <span className="text-[11.5px] text-fg-3 flex items-center gap-1.5">
          <Activity size={12} /> Docker {status.data.version}
          {status.data.usesSudo && <Badge tone="warn">via sudo</Badge>}
        </span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {view === "containers" && <Containers serverId={serverId} />}
        {view === "images" && <Images serverId={serverId} />}
        {view === "volumes" && <Volumes serverId={serverId} />}
        {view === "networks" && <Networks serverId={serverId} />}
      </div>
    </div>
  );
}

export function DockerView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="manage Docker">
      <Docker serverId={tab.serverId!} />
    </ConnectGate>
  );
}
