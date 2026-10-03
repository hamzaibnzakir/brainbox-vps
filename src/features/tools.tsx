import { Activity, Boxes, Cable, Container, FileCode2, FolderTree, GitBranch, Home, KeyRound, LayoutDashboard, ListTree, Network, Radio, ScrollText, Server, Settings, SquareTerminal, Terminal, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { ServerToolKind, TabKind } from "@/stores/workspace";

export interface ToolDef {
  kind: TabKind;
  label: string;
  short?: string;
  icon: (size?: number) => ReactNode;
  shortcut?: string;
  description: string;
}

export const SERVER_TOOLS: Record<ServerToolKind, ToolDef> = {
  overview: { kind: "overview", label: "Overview", icon: (s = 15) => <LayoutDashboard size={s} />, description: "Live CPU, memory, disk and network" },
  terminal: { kind: "terminal", label: "Terminal", icon: (s = 15) => <Terminal size={s} />, shortcut: "Ctrl+Shift+T", description: "Interactive SSH shell" },
  files: { kind: "files", label: "Files", icon: (s = 15) => <FolderTree size={s} />, shortcut: "Ctrl+Shift+F", description: "Dual-pane SFTP file manager" },
  processes: { kind: "processes", label: "Processes", icon: (s = 15) => <Activity size={s} />, description: "Running processes" },
  docker: { kind: "docker", label: "Docker", icon: (s = 15) => <Container size={s} />, description: "Containers, images, volumes" },
  services: { kind: "services", label: "Services", icon: (s = 15) => <Boxes size={s} />, description: "systemd services" },
  logs: { kind: "logs", label: "Logs", icon: (s = 15) => <ScrollText size={s} />, description: "Live log viewer" },
  ports: { kind: "ports", label: "Ports", icon: (s = 15) => <Network size={s} />, description: "Listening ports" },
  git: { kind: "git", label: "Git", icon: (s = 15) => <GitBranch size={s} />, description: "Repositories on the server" },
  tunnels: { kind: "tunnels", label: "Tunnels", icon: (s = 15) => <Cable size={s} />, description: "SSH port forwarding" },
  commands: { kind: "commands", label: "Commands", icon: (s = 15) => <Zap size={s} />, description: "Saved commands & snippets" },
  editor: { kind: "editor", label: "Editor", icon: (s = 15) => <FileCode2 size={s} />, description: "Remote file editor" },
};

export const GLOBAL_TOOLS: Partial<Record<TabKind, ToolDef>> = {
  home: { kind: "home", label: "Home", icon: (s = 15) => <Home size={s} />, description: "All servers at a glance" },
  settings: { kind: "settings", label: "Settings", icon: (s = 15) => <Settings size={s} />, shortcut: "Ctrl+,", description: "Preferences" },
  broadcast: { kind: "broadcast", label: "Broadcast", icon: (s = 15) => <Radio size={s} />, shortcut: "Ctrl+Shift+B", description: "Run a command on many servers" },
  "local-terminal": { kind: "local-terminal", label: "Local Terminal", icon: (s = 15) => <SquareTerminal size={s} />, shortcut: "Ctrl+Shift+L", description: "PowerShell / Command Prompt" },
  "local-files": { kind: "local-files", label: "This PC", icon: (s = 15) => <Server size={s} />, description: "Local files" },
  "all-tunnels": { kind: "all-tunnels", label: "All Tunnels", icon: (s = 15) => <Cable size={s} />, description: "Tunnels across all servers" },
  "all-commands": { kind: "all-commands", label: "Command Center", icon: (s = 15) => <Zap size={s} />, description: "All saved commands" },
  "known-hosts": { kind: "known-hosts", label: "Known Hosts", icon: (s = 15) => <KeyRound size={s} />, description: "Trusted server keys" },
};

export function toolFor(kind: TabKind): ToolDef {
  return (SERVER_TOOLS as Record<string, ToolDef>)[kind] ?? GLOBAL_TOOLS[kind] ?? { kind, label: kind, icon: (s = 15) => <ListTree size={s} />, description: "" };
}
