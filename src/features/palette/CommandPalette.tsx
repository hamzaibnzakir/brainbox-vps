import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Bot, Cable, Download, FolderTree, KeyRound, Layers, LayoutDashboard, Moon, PanelBottom, PanelLeft, Plug, Plus, Radio, RotateCcw, Search, Server, Settings, SquareTerminal, Sun, Terminal, Unplug, XSquare, Zap, Container, Activity } from "lucide-react";
import { api } from "@/services/api";
import { useServers } from "@/stores/servers";
import { useSettings } from "@/stores/settings";
import { useSnippets } from "@/stores/data";
import { useUi } from "@/stores/ui";
import { useWorkspace, type ServerToolKind } from "@/stores/workspace";
import { fuzzyFilter } from "@/lib/fuzzy";
import { cn } from "@/lib/format";
import { Avatar, Kbd, StatusDot } from "@/components/ui";
import { SERVER_TOOLS } from "../tools";
import { connectServer, disconnectServer, openTool } from "../servers/actions";
import { runInTerminal } from "../commands/CommandsView";
import { editTunnel } from "../tunnels/TunnelsView";
import { newWorkspace } from "../workspaces/workspaceActions";
import { runServiceAction } from "../system/ServicesView";
import { refreshAllTerminals } from "../terminal/registry";

interface Item {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  icon: ReactNode;
  shortcut?: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

const recent: string[] = [];

async function restartServicePrompt(serverId: string | null) {
  const ui = useUi.getState();
  const servers = useServers.getState().servers;
  let sid = serverId;
  if (!sid) {
    const r = await ui.prompt({ title: "Restart service", label: "Server name", placeholder: servers.map((s) => s.name).join(", ") });
    sid = servers.find((s) => s.name.toLowerCase() === r?.value.trim().toLowerCase())?.id ?? null;
    if (!sid) return;
  }
  const r = await ui.prompt({ title: "Restart service", label: "Service (systemd unit)", placeholder: "nginx", confirmLabel: "Continue" });
  if (!r?.value.trim()) return;
  if (!(await connectServer(sid))) return;
  const unit = r.value.trim().endsWith(".service") ? r.value.trim() : `${r.value.trim()}.service`;
  await runServiceAction(sid, unit, "restart");
}

export function CommandPalette() {
  const { palette, closePalette } = useUi();
  const servers = useServers((s) => s.servers);
  const statuses = useServers((s) => s.statuses);
  const snippets = useSnippets((s) => s.snippets);
  const settings = useSettings((s) => s.settings);
  const ws = useWorkspace();
  const [q, setQ] = useState(palette.query);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [shells, setShells] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (palette.open) {
      setQ(palette.query);
      setIdx(0);
      void api.localShells().then(setShells).catch(() => {});
    }
  }, [palette.open, palette.query]);

  const selected = ws.tabs.find((t) => t.id === ws.activeTabId)?.serverId ?? ws.selectedServerId;
  const selServer = servers.find((s) => s.id === selected);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const s of servers) {
      const st = statuses[s.id]?.state.state ?? "disconnected";
      out.push({
        id: `srv:${s.id}`,
        title: s.name,
        subtitle: `${s.username}@${s.host}${s.group ? ` · ${s.group}` : ""}`,
        group: "Servers",
        icon: (
          <span className="relative">
            <Avatar name={s.name} color={s.color} size={18} />
            <StatusDot state={st} size={6} className="absolute -bottom-0.5 -right-0.5" />
          </span>
        ),
        keywords: `${s.host} ${s.tags.join(" ")} ssh open terminal`,
        run: () => void openTool(s.id, st === "connected" ? "overview" : "terminal"),
      });
    }
    if (palette.mode === "servers") return out;
    for (const s of servers) {
      const st = statuses[s.id]?.state.state ?? "disconnected";
      out.push({ id: `term:${s.id}`, title: `Terminal: ${s.name}`, group: "Servers", icon: <Terminal size={15} />, keywords: "ssh shell", run: () => void openTool(s.id, "terminal", {}, true) });
      out.push({ id: `files:${s.id}`, title: `Files: ${s.name}`, group: "Servers", icon: <FolderTree size={15} />, keywords: "sftp upload download", run: () => void openTool(s.id, "files") });
      if (st === "connected") out.push({ id: `disc:${s.id}`, title: `Disconnect ${s.name}`, group: "Servers", icon: <Unplug size={15} />, run: () => void disconnectServer(s.id) });
      else out.push({ id: `conn:${s.id}`, title: `Connect ${s.name}`, group: "Servers", icon: <Plug size={15} />, run: () => void connectServer(s.id) });
    }
    if (selServer) {
      for (const k of Object.keys(SERVER_TOOLS) as ServerToolKind[]) {
        if (k === "editor") continue;
        const t = SERVER_TOOLS[k];
        out.push({ id: `tool:${k}`, title: `${t.label}`, subtitle: `${selServer.name} — ${t.description}`, group: `Tools · ${selServer.name}`, icon: t.icon(15), shortcut: t.shortcut, keywords: k === "overview" ? "monitoring dashboard cpu ram disk" : k, run: () => void openTool(selServer.id, k, {}, k === "terminal") });
      }
    }
    const g = "Brainbox";
    out.push(
      { id: "add-server", title: "Add server…", group: g, icon: <Plus size={15} />, keywords: "new vps create", run: () => useUi.getState().openServerEditor(null) },
      { id: "import", title: "Import from ~/.ssh/config…", group: g, icon: <Download size={15} />, run: () => useUi.getState().set({ importOpen: true }) },
      { id: "local-term", title: "New local terminal", group: g, icon: <SquareTerminal size={15} />, shortcut: "Ctrl+Shift+L", keywords: "powershell cmd", run: () => void ws.openTab("local-terminal", null, {}, { newTab: true }) },
      ...shells.map((sh) => ({ id: `shell:${sh.id}`, title: `New ${sh.name} terminal`, group: g, icon: <SquareTerminal size={15} />, run: () => void ws.openTab("local-terminal", null, { shellId: sh.id }, { newTab: true }) })),
      { id: "broadcast", title: "Broadcast command to servers", group: g, icon: <Radio size={15} />, shortcut: "Ctrl+Shift+B", keywords: "multi run many", run: () => void ws.openTab("broadcast") },
      { id: "commands", title: "Command Center", group: g, icon: <Zap size={15} />, keywords: "snippets saved commands", run: () => void ws.openTab("all-commands") },
      { id: "tunnels", title: "All tunnels", group: g, icon: <Cable size={15} />, keywords: "port forward", run: () => void ws.openTab("all-tunnels") },
      { id: "new-tunnel", title: "Create tunnel…", group: g, icon: <Cable size={15} />, keywords: "port forward socks", run: () => void editTunnel(null, selected ? { serverId: selected } : {}) },
      { id: "restart-service", title: "Restart service…", group: g, icon: <RotateCcw size={15} />, keywords: "systemctl nginx", run: () => void restartServicePrompt(selected) },
      { id: "docker", title: "Open Docker", group: g, icon: <Container size={15} />, run: () => { if (selected) void openTool(selected, "docker"); } },
      { id: "monitoring", title: "Open monitoring", group: g, icon: <Activity size={15} />, keywords: "overview cpu ram", run: () => { if (selected) void openTool(selected, "overview"); } },
      { id: "home", title: "Home", group: g, icon: <LayoutDashboard size={15} />, run: () => void ws.openTab("home") },
      { id: "settings", title: "Open settings", group: g, icon: <Settings size={15} />, shortcut: "Ctrl+,", keywords: "preferences", run: () => void ws.openTab("settings") },
      {
        id: "theme",
        title: settings.theme === "light" ? "Switch to dark theme" : "Switch to light theme",
        group: g,
        icon: settings.theme === "light" ? <Moon size={15} /> : <Sun size={15} />,
        keywords: "change theme appearance",
        run: async () => {
          await useSettings.getState().update({ theme: settings.theme === "light" ? "dark" : "light" });
          setTimeout(refreshAllTerminals, 30);
        },
      },
      { id: "sidebar", title: "Toggle sidebar", group: g, icon: <PanelLeft size={15} />, shortcut: "Ctrl+B", run: () => useUi.getState().set({ sidebarVisible: !useUi.getState().sidebarVisible }) },
      { id: "transfers", title: "Show transfers", group: g, icon: <PanelBottom size={15} />, shortcut: "Ctrl+J", run: () => useUi.getState().set({ bottomOpen: true, bottomTab: "transfers" }) },
      { id: "ai", title: "Toggle Brainbox AI", group: g, icon: <Bot size={15} />, shortcut: "Ctrl+I", run: () => useUi.getState().set({ aiOpen: !useUi.getState().aiOpen }) },
      { id: "known-hosts", title: "Known hosts", group: g, icon: <KeyRound size={15} />, run: () => void ws.openTab("known-hosts") },
      { id: "new-ws", title: "New workspace…", group: g, icon: <Layers size={15} />, run: () => void newWorkspace() },
      { id: "close-all", title: "Close all tabs", group: g, icon: <XSquare size={15} />, shortcut: "Ctrl+Shift+W", run: () => void ws.closeAll() },
      ...ws.workspaces.filter((w) => w.id !== ws.currentId).map((w) => ({ id: `ws:${w.id}`, title: `Switch to workspace: ${w.name}`, group: g, icon: <Layers size={15} />, run: () => void ws.switchWorkspace(w.id) })),
    );
    for (const s of snippets) {
      if (s.serverId && s.serverId !== selected) continue;
      out.push({ id: `snip:${s.id}`, title: `Run: ${s.name}`, subtitle: s.command, group: "Saved commands", icon: <Zap size={15} />, shortcut: s.shortcut ?? undefined, keywords: s.category ?? "", run: () => { if (selected) void runInTerminal(selected, s.command); } });
    }
    return out;
  }, [servers, statuses, snippets, settings.theme, ws, selServer, selected, shells, palette.mode]);

  const results = useMemo(() => {
    if (!q.trim()) {
      const r = [...items].sort((a, b) => {
        const ra = recent.indexOf(a.id);
        const rb = recent.indexOf(b.id);
        return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
      });
      return r.slice(0, 80);
    }
    return fuzzyFilter(items, q, (i) => [i.title, i.subtitle ?? "", i.keywords ?? "", i.group]).slice(0, 80).map((r) => r.item);
  }, [items, q]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  if (!palette.open) return null;
  const run = (it: Item) => {
    closePalette();
    const i = recent.indexOf(it.id);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(it.id);
    void it.run();
  };
  let lastGroup = "";
  return createPortal(
    <div className="fixed inset-0 z-[120] flex justify-center pt-[12vh] anim-fade" style={{ background: "rgb(0 0 0 / 0.35)" }} onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="w-[640px] max-w-[92vw] h-fit max-h-[62vh] flex flex-col rounded-xl border border-line-2 bg-bg-2 shadow-pop overflow-hidden anim-pop" role="dialog" aria-label="Command palette" data-testid="command-palette">
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line">
          <Search size={16} className="text-fg-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(results.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter" && results[idx]) (e.preventDefault(), run(results[idx]));
              else if (e.key === "Escape") closePalette();
            }}
            placeholder={palette.mode === "servers" ? "Search servers…" : "Type a command, server or tool…"}
            className="flex-1 bg-transparent text-[14px] text-fg placeholder:text-fg-4"
            data-testid="palette-input"
          />
          <Kbd chord="Esc" />
        </div>
        <div ref={listRef} className="overflow-auto py-1.5" role="listbox">
          {results.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-fg-3">No results for “{q}”</div>}
          {results.map((it, i) => {
            const header = !q.trim() ? null : it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="px-4 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-fg-4">{header}</div>}
                <button
                  data-idx={i}
                  role="option"
                  aria-selected={i === idx}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => run(it)}
                  className={cn("w-[calc(100%-12px)] mx-1.5 flex items-center gap-3 px-2.5 h-9 rounded-md text-left", i === idx ? "bg-accent-soft" : "")}
                >
                  <span className={cn("w-5 flex items-center justify-center shrink-0", i === idx ? "text-accent" : "text-fg-3")}>{it.icon}</span>
                  <span className="text-[13px] text-fg truncate">{it.title}</span>
                  {it.subtitle && <span className="text-[12px] text-fg-4 truncate flex-1">{it.subtitle}</span>}
                  {!it.subtitle && <span className="flex-1" />}
                  {it.shortcut && <Kbd chord={it.shortcut} />}
                  {i === idx && <ArrowRight size={13} className="text-fg-3" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 px-4 h-8 border-t border-line text-[11px] text-fg-4">
          <span className="flex items-center gap-1">
            <Kbd chord="↑" />
            <Kbd chord="↓" /> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd chord="Enter" /> run
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1">
            <Server size={11} /> {palette.mode === "servers" ? "Ctrl+K for all commands" : "Ctrl+P for servers"}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
