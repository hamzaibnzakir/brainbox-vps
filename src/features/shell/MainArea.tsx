import { lazy, Suspense } from "react";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { Spinner } from "@/components/ui";
import { TerminalTab } from "../terminal/TerminalTab";
import { FilesView, LocalFilesView } from "../files/FilesView";
import { HomeView } from "../home/HomeView";
import { OverviewView } from "../overview/OverviewView";
import { ProcessesView } from "../system/ProcessesView";
import { ServicesView } from "../system/ServicesView";
import { PortsView } from "../system/PortsView";
import { LogsView } from "../logs/LogsView";
import { DockerView } from "../docker/DockerView";
import { GitView } from "../git/GitView";
import { TunnelsView } from "../tunnels/TunnelsView";
import { CommandsView } from "../commands/CommandsView";
import { BroadcastView } from "../broadcast/BroadcastView";
import { SettingsView } from "../settings/SettingsView";
import { KnownHostsView } from "../settings/KnownHostsView";
import { ServerHeader } from "./ServerHeader";
import { cn } from "@/lib/format";

const EditorView = lazy(() => import("../editor/EditorView").then((m) => ({ default: m.EditorView })));

/** Tabs whose state must survive being hidden (kept mounted). */
const KEEP_ALIVE = new Set(["terminal", "local-terminal", "editor", "files", "local-files", "logs", "broadcast", "git"]);

function Content({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "terminal":
    case "local-terminal":
      return <TerminalTab tab={tab} active={active} />;
    case "files":
      return <FilesView tab={tab} />;
    case "local-files":
      return <LocalFilesView tab={tab} />;
    case "editor":
      return (
        <Suspense fallback={<div className="h-full flex items-center justify-center"><Spinner /></div>}>
          <EditorView tab={tab} />
        </Suspense>
      );
    case "overview":
      return <OverviewView tab={tab} active={active} />;
    case "processes":
      return <ProcessesView tab={tab} />;
    case "services":
      return <ServicesView tab={tab} />;
    case "ports":
      return <PortsView tab={tab} />;
    case "logs":
      return <LogsView tab={tab} />;
    case "docker":
      return <DockerView tab={tab} />;
    case "git":
      return <GitView tab={tab} />;
    case "tunnels":
    case "all-tunnels":
      return <TunnelsView tab={tab} />;
    case "commands":
    case "all-commands":
      return <CommandsView tab={tab} />;
    case "broadcast":
      return <BroadcastView tab={tab} />;
    case "settings":
      return <SettingsView />;
    case "known-hosts":
      return <KnownHostsView />;
    case "home":
    default:
      return <HomeView />;
  }
}

export function MainArea() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeId = useWorkspace((s) => s.activeTabId);
  const active = tabs.find((t) => t.id === activeId);
  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-bg-2">
      {active?.serverId && <ServerHeader serverId={active.serverId} activeKind={active.kind} />}
      <div className="flex-1 relative min-h-0">
        {tabs.map((t) => {
          const isActive = t.id === activeId;
          if (!isActive && !KEEP_ALIVE.has(t.kind)) return null;
          return (
            <div key={t.id} className={cn("absolute inset-0 flex flex-col", !isActive && "invisible pointer-events-none")} aria-hidden={!isActive} role="tabpanel">
              <Content tab={t} active={isActive} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
