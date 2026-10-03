import { useRef, useState } from "react";
import { Columns2, Copy, FolderTree, Plus, SquareTerminal, Terminal, X, XSquare } from "lucide-react";
import { useServers } from "@/stores/servers";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { openMenu, openMenuAt, type MenuItem } from "@/components/ContextMenu";
import { cn } from "@/lib/format";
import { basename } from "@/lib/paths";
import { toolFor } from "../tools";
import { openTool } from "../servers/actions";

export function useTabTitle(tab: Tab): { title: string; subtitle?: string } {
  const server = useServers((s) => s.servers.find((x) => x.id === tab.serverId));
  const tool = toolFor(tab.kind);
  if (tab.kind === "editor") return { title: basename(tab.data.path ?? "file"), subtitle: server?.name };
  if (tab.kind === "local-terminal") return { title: tab.data.title ?? "Local terminal" };
  if (tab.kind === "terminal") return { title: server?.name ?? "Terminal", subtitle: "Terminal" };
  if (server) return { title: tool.label, subtitle: server.name };
  return { title: tool.label };
}

function TabItem({ tab, index, active, onDragStart, onDrop }: { tab: Tab; index: number; active: boolean; onDragStart: (i: number) => void; onDrop: (i: number) => void }) {
  const { activate, closeTab, closeOthers, closeAll, openTab } = useWorkspace();
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  const server = useServers((s) => s.servers.find((x) => x.id === tab.serverId));
  const status = useServers((s) => (tab.serverId ? s.statuses[tab.serverId]?.state.state : undefined));
  const { title, subtitle } = useTabTitle(tab);
  const tool = toolFor(tab.kind);
  const [over, setOver] = useState(false);

  const menu: MenuItem[] = [
    { label: "Close", icon: <X size={14} />, shortcut: "Ctrl+W", onClick: () => void closeTab(tab.id) },
    { label: "Close others", icon: <XSquare size={14} />, onClick: () => void closeOthers(tab.id) },
    { label: "Close all", onClick: () => void closeAll() },
    ...(tab.kind === "terminal" && tab.serverId
      ? ([{ type: "separator" }, { label: "New terminal on this server", icon: <Copy size={14} />, onClick: () => void openTool(tab.serverId!, "terminal", {}, true) }] as MenuItem[])
      : []),
    ...(tab.kind === "local-terminal" ? ([{ type: "separator" }, { label: "Duplicate", icon: <Copy size={14} />, onClick: () => openTab("local-terminal", null, { shellId: tab.data.shellId }, { newTab: true }) }] as MenuItem[]) : []),
  ];

  return (
    <div
      role="tab"
      aria-selected={active}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={() => {
        setOver(false);
        onDrop(index);
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.id);
        }
      }}
      onClick={() => activate(tab.id)}
      onContextMenu={(e) => openMenu(e, menu)}
      title={subtitle ? `${title} — ${subtitle}` : title}
      className={cn(
        "group relative flex items-center gap-2 h-full pl-3 pr-1.5 min-w-[120px] max-w-[220px] border-r border-line cursor-default select-none transition-colors",
        active ? "bg-bg-2 text-fg" : "text-fg-3 hover:text-fg-2 hover:bg-bg-1",
        over && "bg-accent-softer",
      )}
      data-testid={`tab-${tab.kind}`}
    >
      {active && <span className="absolute top-0 left-0 right-0 h-[2px] bg-accent" />}
      <span className={cn("shrink-0", active ? "text-accent" : "")}>{tool.icon(14)}</span>
      {server && <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: status === "connected" ? server.color ?? "var(--ok)" : "var(--fg-4)" }} />}
      <span className="truncate text-[12.5px] flex-1">
        {title}
        {subtitle && tab.kind !== "terminal" && <span className="text-fg-4"> · {subtitle}</span>}
      </span>
      <button
        className={cn("h-5 w-5 rounded flex items-center justify-center shrink-0", dirty ? "text-fg-2" : "opacity-0 group-hover:opacity-100", "hover:bg-bg-5")}
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(tab.id);
        }}
        aria-label={`Close ${title}`}
      >
        {dirty ? <span className="h-2 w-2 rounded-full bg-fg-2 group-hover:hidden" /> : null}
        <X size={13} className={dirty ? "hidden group-hover:block" : ""} />
      </button>
    </div>
  );
}

export function TabBar() {
  const { tabs, activeTabId, moveTab, selectedServerId, openTab } = useWorkspace();
  const drag = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const newMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [];
    if (selectedServerId) {
      items.push({ label: "New terminal", icon: <Terminal size={14} />, shortcut: "Ctrl+Shift+T", onClick: () => void openTool(selectedServerId, "terminal", {}, true) });
      items.push({ label: "Files", icon: <FolderTree size={14} />, shortcut: "Ctrl+Shift+F", onClick: () => void openTool(selectedServerId, "files") });
      items.push({ type: "separator" });
    }
    items.push({ label: "Local terminal", icon: <SquareTerminal size={14} />, onClick: () => openTab("local-terminal", null, {}, { newTab: true }) });
    items.push({ label: "Broadcast", icon: <Columns2 size={14} />, onClick: () => openTab("broadcast") });
    openMenuAt(el, items);
  };
  return (
    <div className="flex items-stretch h-9 bg-bg-0 border-b border-line shrink-0" role="tablist" aria-label="Open tabs">
      <div
        ref={scroller}
        className="flex items-stretch overflow-x-auto overflow-y-hidden min-w-0 [&::-webkit-scrollbar]:h-0"
        onWheel={(e) => {
          if (scroller.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scroller.current.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t, i) => (
          <TabItem
            key={t.id}
            tab={t}
            index={i}
            active={t.id === activeTabId}
            onDragStart={(idx) => (drag.current = idx)}
            onDrop={(idx) => {
              if (drag.current != null && drag.current !== idx) moveTab(drag.current, idx);
              drag.current = null;
            }}
          />
        ))}
      </div>
      <button className="w-9 shrink-0 flex items-center justify-center text-fg-3 hover:text-fg hover:bg-bg-2" onClick={(e) => newMenu(e.currentTarget)} aria-label="New tab" title="New tab">
        <Plus size={15} />
      </button>
      <div className="flex-1 drag" />
    </div>
  );
}
