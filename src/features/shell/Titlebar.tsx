import { useEffect, useState } from "react";
import { Bot, Check, ChevronDown, Copy, Layers, Minus, PanelBottom, PanelLeft, Plus, Search, Settings, Square, Trash2, Pencil, X, Users } from "lucide-react";
import { platform } from "@/services/platform";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useTransfers, activeTransferCount } from "@/stores/data";
import { openMenuAt, type MenuItem } from "@/components/ContextMenu";
import { IconButton, Kbd } from "@/components/ui";
import { cn } from "@/lib/format";
import { manageWorkspaceServers, newWorkspace } from "../workspaces/workspaceActions";

function WindowControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    void platform.isMaximized().then(setMax);
    void platform.onResized(() => void platform.isMaximized().then(setMax)).then((u) => (un = u));
    return () => un?.();
  }, []);
  const btn = "h-full w-[46px] inline-flex items-center justify-center text-fg-2 hover:bg-bg-4 hover:text-fg transition-colors";
  return (
    <div className="flex h-full no-drag">
      <button className={btn} onClick={() => void platform.minimize()} aria-label="Minimize">
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button className={btn} onClick={() => void platform.toggleMaximize()} aria-label={max ? "Restore" : "Maximize"}>
        {max ? <Copy size={12} strokeWidth={1.5} className="-scale-x-100" /> : <Square size={12} strokeWidth={1.5} />}
      </button>
      <button className={cn(btn, "hover:bg-[#e81123] hover:text-white")} onClick={() => void platform.close()} aria-label="Close">
        <X size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function WorkspaceSwitcher() {
  const { workspaces, currentId, switchWorkspace, renameWorkspace, deleteWorkspace } = useWorkspace();
  const prompt = useUi((s) => s.prompt);
  const confirm = useUi((s) => s.confirm);
  const current = workspaces.find((w) => w.id === currentId);
  const open = (el: HTMLElement) => {
    const items: MenuItem[] = [
      { type: "header", label: "Workspaces" },
      ...workspaces.map((w) => ({
        label: w.name,
        icon: w.id === currentId ? <Check size={14} className="text-accent" /> : <Layers size={14} />,
        hint: w.serverIds.length ? `${w.serverIds.length} servers` : undefined,
        onClick: () => void switchWorkspace(w.id),
      })),
      { type: "separator" },
      { label: "New workspace…", icon: <Plus size={14} />, onClick: () => void newWorkspace() },
      { label: "Choose servers…", icon: <Users size={14} />, disabled: !current, onClick: () => current && void manageWorkspaceServers(current.id) },
      {
        label: "Rename workspace…",
        icon: <Pencil size={14} />,
        disabled: !current,
        onClick: async () => {
          const r = await prompt({ title: "Rename workspace", initial: current?.name, label: "Name", confirmLabel: "Rename" });
          if (r && current) await renameWorkspace(current.id, r.value.trim() || current.name);
        },
      },
      {
        label: "Delete workspace",
        icon: <Trash2 size={14} />,
        danger: true,
        disabled: workspaces.length <= 1,
        onClick: async () => {
          if (current && (await confirm({ title: `Delete “${current.name}”?`, message: "Its tab layout is removed. Servers are not deleted.", danger: true, confirmLabel: "Delete" }))) await deleteWorkspace(current.id);
        },
      },
    ];
    openMenuAt(el, items);
  };
  return (
    <button
      className="no-drag h-7 pl-2 pr-1.5 rounded-md inline-flex items-center gap-1.5 text-[12.5px] text-fg-2 hover:bg-bg-3 hover:text-fg max-w-[220px]"
      onClick={(e) => open(e.currentTarget)}
      title="Switch workspace"
      data-testid="workspace-switcher"
    >
      <Layers size={13} className="text-accent shrink-0" />
      <span className="truncate font-medium">{current?.name ?? "Workspace"}</span>
      <ChevronDown size={13} className="text-fg-3 shrink-0" />
    </button>
  );
}

export function Titlebar() {
  const ui = useUi();
  const transfers = useTransfers((s) => s.items);
  const active = activeTransferCount(transfers);
  return (
    <header
      className="drag h-[38px] shrink-0 flex items-center bg-bg-0 border-b border-line select-none"
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".no-drag")) return;
        void platform.toggleMaximize();
      }}
    >
      <div className="flex items-center gap-2 pl-3 pr-2 h-full">
        <img src="/logo.svg" alt="" className="h-[18px] w-[18px] rounded-[5px]" draggable={false} />
        <span className="text-[12.5px] font-semibold tracking-tight text-fg">
          Brainbox <span className="text-accent">VPS</span>
        </span>
      </div>
      <div className="h-4 w-px bg-line mx-1" />
      <WorkspaceSwitcher />
      <div className="flex-1 flex justify-center px-4 min-w-0">
        <button
          className="no-drag w-full max-w-[460px] h-[26px] rounded-md bg-bg-2 border border-line hover:border-line-2 text-fg-3 hover:text-fg-2 text-[12px] inline-flex items-center gap-2 px-2.5 transition-colors"
          onClick={() => ui.openPalette("commands")}
          data-testid="titlebar-search"
        >
          <Search size={13} />
          <span className="flex-1 text-left truncate">Search servers, commands, tools…</span>
          <Kbd chord="Ctrl+K" />
        </button>
      </div>
      <div className="flex items-center gap-0.5 pr-1 no-drag">
        <IconButton label="Toggle sidebar (Ctrl+B)" active={ui.sidebarVisible} onClick={() => ui.set({ sidebarVisible: !ui.sidebarVisible })}>
          <PanelLeft size={15} />
        </IconButton>
        <div className="relative">
          <IconButton label="Transfers (Ctrl+J)" active={ui.bottomOpen} onClick={() => ui.set({ bottomOpen: !ui.bottomOpen, bottomTab: "transfers" })}>
            <PanelBottom size={15} />
          </IconButton>
          {active > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-white text-[9.5px] font-bold flex items-center justify-center pointer-events-none">{active}</span>}
        </div>
        <IconButton label="Brainbox AI (Ctrl+I)" active={ui.aiOpen} onClick={() => ui.set({ aiOpen: !ui.aiOpen })} data-testid="toggle-ai">
          <Bot size={15} />
        </IconButton>
        <IconButton label="Settings (Ctrl+,)" onClick={() => useWorkspace.getState().openTab("settings")}>
          <Settings size={15} />
        </IconButton>
      </div>
      <WindowControls />
    </header>
  );
}
