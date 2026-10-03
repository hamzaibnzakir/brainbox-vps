import { ArrowDownUp, Cable, Cloud, Keyboard, Wifi, WifiOff } from "lucide-react";
import { useServers } from "@/stores/servers";
import { useTransfers, useTunnels } from "@/stores/data";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { formatRate } from "@/lib/format";

export function StatusBar() {
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const selected = useWorkspace((s) => s.selectedServerId);
  const serverId = activeTab?.serverId ?? selected;
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const status = useServers((s) => (serverId ? s.statuses[serverId] : undefined));
  const connectedCount = useServers((s) => Object.values(s.statuses).filter((x) => x.state.state === "connected").length);
  const transfers = useTransfers((s) => s.items);
  const tunnels = useTunnels((s) => s.statuses);
  const ui = useUi();
  const running = Object.values(transfers).filter((t) => t.state === "running" || t.state === "queued");
  const speed = running.reduce((a, t) => a + t.speedBps, 0);
  const tunnelCount = Object.values(tunnels).filter((t) => t.state === "running").length;
  const state = status?.state.state;

  return (
    <footer className="h-6 shrink-0 flex items-center gap-4 px-3 bg-bg-0 border-t border-line text-[11px] text-fg-3 select-none" role="status">
      {server ? (
        <span className="flex items-center gap-1.5">
          {state === "connected" ? <Wifi size={12} className="text-ok" /> : <WifiOff size={12} className={state === "reconnecting" ? "text-warn" : ""} />}
          <span className="text-fg-2">{server.name}</span>
          {state === "connected" && status?.latencyMs != null && <span>{status.latencyMs} ms</span>}
          {state === "reconnecting" && <span className="text-warn">reconnecting…</span>}
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <Cloud size={12} />
          No server selected
        </span>
      )}
      <span>{connectedCount} connected</span>
      <button className="flex items-center gap-1 hover:text-fg-2" onClick={() => ui.set({ bottomOpen: true, bottomTab: "transfers" })}>
        <ArrowDownUp size={12} />
        {running.length ? (
          <span className="text-fg-2">
            {running.length} transfer{running.length > 1 ? "s" : ""} · {formatRate(speed)}
          </span>
        ) : (
          "No transfers"
        )}
      </button>
      {tunnelCount > 0 && (
        <button className="flex items-center gap-1 hover:text-fg-2" onClick={() => useWorkspace.getState().openTab("all-tunnels")}>
          <Cable size={12} />
          {tunnelCount} tunnel{tunnelCount > 1 ? "s" : ""} active
        </button>
      )}
      <span className="flex-1" />
      <button className="flex items-center gap-1 hover:text-fg-2" onClick={() => ui.openPalette("commands")}>
        <Keyboard size={12} />
        Ctrl+K
      </button>
      <span>Brainbox VPS</span>
    </footer>
  );
}
