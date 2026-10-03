import { useMemo, useRef, useState } from "react";
import { ArrowDownUp, ChevronRight, Download, FolderTree, HardDrive, MoreHorizontal, Plus, Server, SquareTerminal, Star, Terminal } from "lucide-react";
import type { ServerProfile } from "@/types/generated";
import { useServers } from "@/stores/servers";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { connectServer, openTool, serverMenu } from "../servers/actions";
import { openMenu, openMenuAt, type MenuItem } from "@/components/ContextMenu";
import { Avatar, IconButton, SearchInput, Segmented, StatusDot } from "@/components/ui";
import { Resizer } from "@/components/Split";
import { cn } from "@/lib/format";
import { fuzzyFilter } from "@/lib/fuzzy";
import { api } from "@/services/api";
import { useAsync } from "@/hooks/useAsync";

type SortMode = "manual" | "name" | "recent" | "status";
type Filter = "all" | "favorites" | "online";

function MiniBar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="w-[34px] h-[3px] rounded-full bg-bg-5 overflow-hidden">
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, value)}%`, background: value > 90 ? "var(--danger)" : value > 75 ? "var(--warn)" : tone }} />
    </div>
  );
}

function ServerRow({ s, selected, onSelect, focused }: { s: ServerProfile; selected: boolean; onSelect: () => void; focused: boolean }) {
  const status = useServers((st) => st.statuses[s.id]);
  const m = useServers((st) => st.metrics[s.id]);
  const state = status?.state.state ?? "disconnected";
  const cpu = m?.cpuPercent ?? 0;
  const mem = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const disk = m?.disks?.[0] ? (m.disks[0].usedBytes / Math.max(1, m.disks[0].totalBytes)) * 100 : 0;
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-server-id={s.id}
      onClick={onSelect}
      onDoubleClick={() => void openTool(s.id, "terminal", {}, false)}
      onContextMenu={(e) => openMenu(e, serverMenu(s))}
      className={cn(
        "group relative flex items-center gap-2.5 mx-1.5 px-2 rounded-md cursor-default transition-colors",
        "h-[calc(var(--row-h)+14px)]",
        selected ? "bg-accent-soft" : "hover:bg-bg-3",
      )}
      title={`${s.username}@${s.host}:${s.port}`}
    >
      {selected && <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-accent -ml-1.5" />}
      <div className="relative">
        <Avatar name={s.name} color={s.color} size={26} />
        <StatusDot state={state} size={8} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-bg-1 rounded-full" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className={cn("truncate text-[13px] font-medium", selected ? "text-fg" : "text-fg/90")}>{s.name}</span>
          {s.favorite && <Star size={10} className="text-warn fill-warn shrink-0" />}
        </div>
        {state === "connected" && m ? (
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-fg-3 tabular" title={`CPU ${cpu.toFixed(0)}% · RAM ${mem.toFixed(0)}% · Disk ${disk.toFixed(0)}%`}>
            <MiniBar value={cpu} tone="var(--accent)" />
            <MiniBar value={mem} tone="var(--info)" />
            <MiniBar value={disk} tone="var(--ok)" />
            {status?.latencyMs != null && <span className="ml-auto">{status.latencyMs}ms</span>}
          </div>
        ) : (
          <div className="truncate text-[11px] text-fg-3">
            {state === "connecting" ? "Connecting…" : state === "reconnecting" ? "Reconnecting…" : state === "failed" ? <span className="text-danger/90">{(status?.state as { error?: { title: string } }).error?.title ?? "Failed"}</span> : `${s.username}@${s.host}`}
          </div>
        )}
      </div>
      <div className="hidden group-hover:flex items-center gap-0.5">
        <IconButton label="Open terminal" size="xs" onClick={(e) => (e.stopPropagation(), void openTool(s.id, "terminal", {}, true))}>
          <Terminal size={12} />
        </IconButton>
        <IconButton label="More" size="xs" onClick={(e) => (e.stopPropagation(), openMenuAt(e.currentTarget, serverMenu(s)))}>
          <MoreHorizontal size={12} />
        </IconButton>
      </div>
    </div>
  );
}

function Group({ name, count, open, onToggle, children }: { name: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <button onClick={onToggle} className="w-full flex items-center gap-1 px-3 h-6 text-[10.5px] font-semibold uppercase tracking-wider text-fg-3 hover:text-fg-2" aria-expanded={open}>
        <ChevronRight size={11} className={cn("transition-transform", open && "rotate-90")} />
        <span className="truncate">{name}</span>
        <span className="ml-auto text-fg-4 font-normal">{count}</span>
      </button>
      {open && <div className="space-y-px">{children}</div>}
    </div>
  );
}

export function Sidebar() {
  const servers = useServers((s) => s.servers);
  const statuses = useServers((s) => s.statuses);
  const ui = useUi();
  const { selectedServerId, selectServer, workspaces, currentId } = useWorkspace();
  const ws = workspaces.find((w) => w.id === currentId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortMode>("manual");
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const shells = useAsync(() => api.localShells(), []);

  const visible = useMemo(() => {
    let list = servers;
    if (ws?.serverIds.length && scope === "workspace") list = list.filter((s) => ws.serverIds.includes(s.id));
    if (filter === "favorites") list = list.filter((s) => s.favorite);
    if (filter === "online") list = list.filter((s) => statuses[s.id]?.state.state === "connected");
    const tagQ = query.match(/tag:(\S+)/)?.[1]?.toLowerCase();
    if (tagQ) list = list.filter((s) => s.tags.some((t) => t.toLowerCase().includes(tagQ)));
    const q = query.replace(/tag:\S+/, "").trim();
    if (q) return fuzzyFilter(list, q, (s) => [s.name, s.host, s.username, s.group ?? "", ...s.tags]).map((r) => r.item);
    const sorted = [...list];
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "recent") sorted.sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0));
    if (sort === "status") {
      const rank = (id: string) => ({ connected: 0, reconnecting: 1, connecting: 1, failed: 2, disconnected: 3 })[statuses[id]?.state.state ?? "disconnected"];
      sorted.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
    }
    return sorted;
  }, [servers, ws, scope, filter, query, sort, statuses]);

  const grouped = useMemo(() => {
    if (query.trim() || sort !== "manual") return null;
    const map = new Map<string, ServerProfile[]>();
    for (const s of visible) {
      const g = s.group || "Servers";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    return [...map.entries()];
  }, [visible, query, sort]);

  const flat = grouped ? grouped.flatMap(([g, l]) => (collapsed[g] ? [] : l)) : visible;
  const focusId = selectedServerId && flat.some((s) => s.id === selectedServerId) ? selectedServerId : flat[0]?.id;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = flat.findIndex((s) => s.id === focusId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) {
        selectServer(n.id);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-server-id="${n.id}"]`)?.focus());
      }
    } else if (e.key === "Enter" && focusId) {
      void openTool(focusId, e.shiftKey ? "files" : "terminal", {}, false);
    } else if (e.key === "F2" && focusId) {
      const s = flat[i];
      if (s) ui.openServerEditor(s.id);
    } else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && focusId) {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-server-id="${focusId}"]`);
      const s = flat[i];
      if (el && s) openMenuAt(el, serverMenu(s));
    }
  };

  const sortMenu = (el: HTMLElement) => {
    const opt = (m: SortMode, label: string): MenuItem => ({ label, icon: sort === m ? <span className="text-accent">●</span> : <span />, onClick: () => setSort(m) });
    openMenuAt(el, [{ type: "header", label: "Sort servers" }, opt("manual", "Groups (manual)"), opt("name", "Name"), opt("recent", "Recently connected"), opt("status", "Status")]);
  };

  const localMenu = (el: HTMLElement) =>
    openMenuAt(
      el,
      (shells.data ?? []).map((sh) => ({
        label: sh.name,
        icon: <SquareTerminal size={14} />,
        hint: sh.isDefault ? "default" : undefined,
        onClick: () => useWorkspace.getState().openTab("local-terminal", null, { shellId: sh.id }, { newTab: true }),
      })),
    );

  if (!ui.sidebarVisible) return null;
  return (
    <>
      <aside className="flex flex-col bg-bg-1 shrink-0 min-h-0" style={{ width: ui.sidebarWidth }} aria-label="Servers">
        <div className="flex items-center gap-1 px-3 pt-3 pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-3">Servers</span>
          <span className="text-[11px] text-fg-4">{servers.length}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label="Sort" size="xs" onClick={(e) => sortMenu(e.currentTarget)}>
              <ArrowDownUp size={12} />
            </IconButton>
            <IconButton label="Import from OpenSSH config" size="xs" onClick={() => ui.set({ importOpen: true })}>
              <Download size={12} />
            </IconButton>
            <IconButton label="Add server" size="xs" onClick={() => ui.openServerEditor(null)} data-testid="add-server">
              <Plus size={14} />
            </IconButton>
          </div>
        </div>
        <div className="px-3 pb-2 space-y-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Filter servers  (tag:web)" />
          <div className="flex items-center justify-between">
            <Segmented
              size="xs"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "favorites", label: <Star size={11} />, title: "Favorites" },
                { value: "online", label: "Online" },
              ]}
            />
            {!!ws?.serverIds.length && (
              <button className="text-[11px] text-fg-3 hover:text-accent" onClick={() => setScope(scope === "workspace" ? "all" : "workspace")}>
                {scope === "workspace" ? "Show all" : "Workspace only"}
              </button>
            )}
          </div>
        </div>
        <div ref={listRef} role="tree" className="flex-1 overflow-y-auto overflow-x-hidden pb-2" onKeyDown={onKeyDown}>
          {visible.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <div className="mx-auto mb-3 h-10 w-10 rounded-xl bg-bg-3 border border-line flex items-center justify-center text-fg-3">
                <Server size={18} />
              </div>
              <p className="text-[12.5px] text-fg-2 font-medium">{servers.length ? "No matching servers" : "No servers yet"}</p>
              {!servers.length && (
                <div className="mt-3 flex flex-col gap-1.5 items-center">
                  <button className="text-[12px] text-accent hover:underline" onClick={() => ui.openServerEditor(null)}>
                    Add your first server
                  </button>
                  <button className="text-[12px] text-fg-3 hover:text-fg-2" onClick={() => ui.set({ importOpen: true })}>
                    or import ~/.ssh/config
                  </button>
                </div>
              )}
            </div>
          ) : grouped ? (
            grouped.map(([g, list]) => (
              <Group key={g} name={g} count={list.length} open={!collapsed[g]} onToggle={() => setCollapsed({ ...collapsed, [g]: !collapsed[g] })}>
                {list.map((s) => (
                  <ServerRow key={s.id} s={s} selected={s.id === selectedServerId} focused={s.id === focusId} onSelect={() => selectServer(s.id)} />
                ))}
              </Group>
            ))
          ) : (
            visible.map((s) => <ServerRow key={s.id} s={s} selected={s.id === selectedServerId} focused={s.id === focusId} onSelect={() => selectServer(s.id)} />)
          )}
        </div>
        <div className="border-t border-line p-1.5 space-y-px">
          <div className="px-2 pt-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-fg-4">This PC</div>
          <div className="flex items-center group">
            <button
              className="flex-1 flex items-center gap-2.5 h-8 px-2 rounded-md text-[12.5px] text-fg-2 hover:bg-bg-3 hover:text-fg"
              onClick={() => useWorkspace.getState().openTab("local-terminal", null, {}, { newTab: true })}
              data-testid="open-local-terminal"
            >
              <SquareTerminal size={15} className="text-fg-3" />
              Local terminal
            </button>
            <IconButton label="Choose shell" size="xs" className="opacity-0 group-hover:opacity-100" onClick={(e) => localMenu(e.currentTarget)}>
              <ChevronRight size={12} className="rotate-90" />
            </IconButton>
          </div>
          <button className="w-full flex items-center gap-2.5 h-8 px-2 rounded-md text-[12.5px] text-fg-2 hover:bg-bg-3 hover:text-fg" onClick={() => useWorkspace.getState().openTab("local-files")}>
            <HardDrive size={15} className="text-fg-3" />
            Local files
          </button>
          {selectedServerId && (
            <button className="w-full flex items-center gap-2.5 h-8 px-2 rounded-md text-[12.5px] text-fg-2 hover:bg-bg-3 hover:text-fg" onClick={() => selectedServerId && void openTool(selectedServerId, "files")}>
              <FolderTree size={15} className="text-fg-3" />
              Transfer files…
            </button>
          )}
        </div>
      </aside>
      <Resizer dir="row" onDrag={(d) => ui.set({ sidebarWidth: Math.max(200, Math.min(480, useUi.getState().sidebarWidth + d)) })} onEnd={() => useWorkspace.getState().persist()} />
    </>
  );
}

export { connectServer };
