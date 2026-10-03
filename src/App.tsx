import { useEffect, useState } from "react";
import type { AppNotification, HostKeyPrompt } from "@/types/generated";
import { api, EVENTS, on } from "@/services/api";
import { platform } from "@/services/platform";
import { useSettings } from "@/stores/settings";
import { useServers, wireServerEvents } from "@/stores/servers";
import { useSnippets, useTransfers, useTunnels, wireDataEvents } from "@/stores/data";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { matches } from "@/lib/keys";
import { Titlebar } from "@/features/shell/Titlebar";
import { Sidebar } from "@/features/shell/Sidebar";
import { TabBar } from "@/features/shell/TabBar";
import { MainArea } from "@/features/shell/MainArea";
import { StatusBar } from "@/features/shell/StatusBar";
import { TransfersPanel } from "@/features/files/TransfersPanel";
import { AiPanel } from "@/features/ai/AiPanel";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { ServerEditor } from "@/features/servers/ServerEditor";
import { ImportDialog } from "@/features/servers/ImportDialog";
import { HostKeyDialog } from "@/features/servers/HostKeyDialog";
import { DialogHost, ToastHost } from "@/components/DialogHost";
import { ContextMenuHost } from "@/components/ContextMenu";
import { Spinner } from "@/components/ui";
import { connectServer, openTool } from "@/features/servers/actions";
import { runInTerminal } from "@/features/commands/CommandsView";

function inTerminal(): boolean {
  return !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const ws = useWorkspace.getState();
      const term = inTerminal();
      const sel = ws.tabs.find((t) => t.id === ws.activeTabId)?.serverId ?? ws.selectedServerId;
      const hit = (chord: string, fn: () => void, allowInTerminal = true) => {
        if (!matches(e, chord) || (term && !allowInTerminal)) return false;
        e.preventDefault();
        e.stopPropagation();
        fn();
        return true;
      };
      if (ui.dialogs.length || ui.serverEditor.open) return;
      if (
        hit("Ctrl+Shift+P", () => ui.openPalette("commands")) ||
        hit("Ctrl+K", () => ui.openPalette("commands"), false) ||
        hit("Ctrl+P", () => ui.openPalette("servers"), false) ||
        hit("Ctrl+Shift+T", () => (sel ? void openTool(sel, "terminal", {}, true) : ws.openTab("local-terminal", null, {}, { newTab: true }))) ||
        hit("Ctrl+Shift+L", () => ws.openTab("local-terminal", null, {}, { newTab: true })) ||
        hit("Ctrl+Shift+F", () => (sel ? void openTool(sel, "files") : ws.openTab("local-files"))) ||
        hit("Ctrl+Shift+B", () => ws.openTab("broadcast")) ||
        hit("Ctrl+Shift+W", async () => {
          if (await ui.confirm({ title: "Close all tabs in this workspace?", message: "Terminal sessions in these tabs are ended (tmux sessions keep running on the server).", confirmLabel: "Close all" })) void ws.closeAll();
        }) ||
        hit("Ctrl+W", () => ws.activeTabId && void ws.closeTab(ws.activeTabId), false) ||
        hit("Ctrl+F4", () => ws.activeTabId && void ws.closeTab(ws.activeTabId)) ||
        hit("Ctrl+Tab", () => ws.cycle(1)) ||
        hit("Ctrl+Shift+Tab", () => ws.cycle(-1)) ||
        hit("Ctrl+PageDown", () => ws.cycle(1)) ||
        hit("Ctrl+PageUp", () => ws.cycle(-1)) ||
        hit("Ctrl+B", () => ui.set({ sidebarVisible: !ui.sidebarVisible }), false) ||
        hit("Ctrl+J", () => ui.set({ bottomOpen: !ui.bottomOpen }), false) ||
        hit("Ctrl+I", () => ui.set({ aiOpen: !ui.aiOpen }), false) ||
        hit("Ctrl+,", () => ws.openTab("settings"))
      )
        return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const t = ws.tabs[Number(e.code.slice(5)) - 1];
        if (t) {
          e.preventDefault();
          ws.activate(t.id);
        }
        return;
      }
      // User-defined command shortcuts.
      for (const s of useSnippets.getState().snippets) {
        if (s.shortcut && matches(e, s.shortcut) && (!s.serverId || s.serverId === sel) && sel) {
          e.preventDefault();
          void runInTerminal(sel, s.command);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

const NOTIFY_KIND: Record<string, "info" | "success" | "warning" | "error"> = {
  ssh_disconnected: "warning",
  ssh_reconnected: "success",
  transfer_finished: "success",
  container_stopped: "warning",
  server_unreachable: "error",
  command_finished: "info",
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  useGlobalShortcuts();

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    (async () => {
      try {
        await useSettings.getState().load();
        await Promise.all([wireServerEvents(), wireDataEvents()]);
        await Promise.all([useServers.getState().load(), useTransfers.getState().load(), useTunnels.getState().load(), useSnippets.getState().load()]);
        await useWorkspace.getState().init();
        if (!useSettings.getState().settings.restoreWorkspace) {
          const ws = useWorkspace.getState();
          await ws.closeAll();
        }
        unsubs.push(await on<HostKeyPrompt>(EVENTS.hostKeyPrompt, (p) => useUi.getState().pushHostKey(p)));
        for (const p of await api.hostKeyPending()) useUi.getState().pushHostKey(p);
        unsubs.push(
          await on<AppNotification>(EVENTS.notify, (n) => {
            useUi.getState().toast({ kind: NOTIFY_KIND[n.kind] ?? "info", title: n.title, body: n.body });
          }),
        );
        unsubs.push(
          await on<string>(EVENTS.appCommand, (c) => {
            if (c === "palette") useUi.getState().openPalette("commands");
            if (c === "transfers") useUi.getState().set({ bottomOpen: true, bottomTab: "transfers" });
          }),
        );
        if (!cancelled) setReady(true);

        // Background monitoring for every connected server (sidebar mini-bars).
        const startBg = (id: string) => void api.monitorStart(id, useSettings.getState().settings.backgroundMonitorIntervalMs).catch(() => {});
        const known = new Set<string>();
        for (const [id, st] of Object.entries(useServers.getState().statuses)) if (st.state.state === "connected") (known.add(id), startBg(id));
        unsubs.push(
          useServers.subscribe((s) => {
            for (const [id, st] of Object.entries(s.statuses)) {
              const c = st.state.state === "connected";
              if (c && !known.has(id)) {
                known.add(id);
                startBg(id);
              } else if (!c && st.state.state !== "reconnecting") known.delete(id);
            }
          }),
        );

        // Restore: reconnect servers used by the restored tabs (only those that
        // don't need a typed password, so startup never nags).
        if (useSettings.getState().settings.restoreWorkspace) {
          const ids = new Set(useWorkspace.getState().tabs.map((t) => t.serverId).filter(Boolean) as string[]);
          for (const id of ids) {
            const s = useServers.getState().servers.find((x) => x.id === id);
            if (s && (s.authMethod !== "password" || s.hasPassword)) void connectServer(id, { quiet: true });
          }
        }

        if (useSettings.getState().settings.checkUpdates) {
          setTimeout(() => {
            void platform
              .checkForUpdate()
              .then((u) => {
                if (u) useUi.getState().toast({ kind: "info", title: `Brainbox VPS ${u.version} is available`, timeout: 0, action: { label: "Install & restart", run: () => void u.install() } });
              })
              .catch(() => {});
          }, 4000);
        }
      } catch (e) {
        console.error(e);
        setFatal(String((e as { message?: string })?.message ?? e));
      }
    })();
    const flush = () => void useWorkspace.getState().flush();
    window.addEventListener("beforeunload", flush);
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  if (fatal)
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div>
          <div className="text-[15px] font-semibold text-fg">Brainbox VPS couldn't start</div>
          <div className="text-[12.5px] text-fg-3 mt-1 font-mono">{fatal}</div>
        </div>
      </div>
    );
  if (!ready)
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 anim-fade">
        <img src="/logo.svg" alt="" className="h-12 w-12" />
        <Spinner size={18} className="text-accent" />
      </div>
    );

  return (
    <div className="h-full flex flex-col bg-bg-0 text-fg">
      <Titlebar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <TabBar />
          <MainArea />
          <TransfersPanel />
        </main>
        <AiPanel />
      </div>
      <StatusBar />
      <CommandPalette />
      <ServerEditor />
      <ImportDialog />
      <HostKeyDialog />
      <DialogHost />
      <ContextMenuHost />
      <ToastHost />
    </div>
  );
}
