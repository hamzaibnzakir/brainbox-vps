/**
 * Typed client for every backend command. Argument names are camelCase; Tauri
 * maps them to the snake_case Rust parameters.
 */
import { getBackend, type Unlisten } from "./backend";
import type * as T from "@/types/generated";

async function call<R>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  const b = await getBackend();
  return b.invoke<R>(cmd, args);
}

export async function on<P>(event: string, cb: (p: P) => void): Promise<Unlisten> {
  const b = await getBackend();
  return b.listen<P>(event, cb);
}

async function chan<M>(cb: (m: M) => void): Promise<unknown> {
  const b = await getBackend();
  return b.channel<M>(cb);
}

export const EVENTS = {
  connectionStatus: "connection://status",
  hostKeyPrompt: "connection://host-key",
  metrics: "monitor://metrics",
  transfer: "transfer://update",
  tunnel: "tunnel://status",
  broadcast: "broadcast://result",
  notify: "app://notify",
  appCommand: "app://command",
} as const;

export interface AppInfo {
  version: string;
  dataDir: string;
  vaultBackend: string;
  platform: string;
}

export interface BroadcastRun {
  broadcastId: string;
  results: T.BroadcastResult[];
}

export const api = {
  // servers
  serversList: () => call<T.ServerProfile[]>("servers_list"),
  serverCreate: (input: T.ServerInput) => call<T.ServerProfile>("server_create", { input }),
  serverUpdate: (id: string, input: T.ServerInput) => call<T.ServerProfile>("server_update", { id, input }),
  serverDelete: (id: string) => call<void>("server_delete", { id }),
  serverDuplicate: (id: string) => call<T.ServerProfile>("server_duplicate", { id }),
  serverSetFavorite: (id: string, favorite: boolean) => call<T.ServerProfile>("server_set_favorite", { id, favorite }),
  serverRename: (id: string, name: string) => call<T.ServerProfile>("server_rename", { id, name }),
  serversSetGroup: (ids: string[], group: string | null) => call<void>("servers_set_group", { ids, group }),
  serversReorder: (ids: string[]) => call<void>("servers_reorder", { ids }),
  sshConfigScan: () => call<T.SshConfigHost[]>("ssh_config_scan"),
  sshConfigImport: (hosts: T.SshConfigHost[]) => call<T.ServerProfile[]>("ssh_config_import", { hosts }),
  knownHostsList: () => call<T.KnownHost[]>("known_hosts_list"),
  knownHostForget: (host: string, port: number) => call<void>("known_host_forget", { host, port }),

  // connections
  connect: (serverId: string, opts?: { password?: string; passphrase?: string; save?: boolean }) =>
    call<T.ConnectionStatus>("connect", { serverId, password: opts?.password ?? null, passphrase: opts?.passphrase ?? null, save: opts?.save ?? false }),
  disconnect: (serverId: string) => call<void>("disconnect", { serverId }),
  connectionStatuses: () => call<T.ConnectionStatus[]>("connection_statuses"),
  hostKeyAnswer: (requestId: string, decision: T.HostKeyDecision) => call<boolean>("host_key_answer", { requestId, decision }),
  hostKeyPending: () => call<T.HostKeyPrompt[]>("host_key_pending"),

  // terminals
  terminalOpen: async (req: T.TerminalOpenRequest, onEvent: (e: T.TerminalEvent) => void) =>
    call<T.TerminalInfo>("terminal_open", { req, onEvent: await chan(onEvent) }),
  terminalOpenLocal: async (shellId: string | null, cols: number, rows: number, cwd: string | null, onEvent: (e: T.TerminalEvent) => void) =>
    call<T.TerminalInfo>("terminal_open_local", { shellId, cols, rows, cwd, onEvent: await chan(onEvent) }),
  terminalWrite: (id: string, data: string, binary = false) => call<void>("terminal_write", { id, data, binary }),
  terminalResize: (id: string, cols: number, rows: number) => call<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: string) => call<void>("terminal_close", { id }),
  localShells: () => call<T.LocalShellInfo[]>("local_shells"),
  tmuxSessions: (serverId: string) => call<string[]>("tmux_sessions", { serverId }),

  // remote files
  sftpHome: (serverId: string) => call<string>("sftp_home", { serverId }),
  sftpList: (serverId: string, path: string) => call<T.DirListing>("sftp_list", { serverId, path }),
  sftpStat: (serverId: string, path: string) => call<T.FileEntry>("sftp_stat", { serverId, path }),
  sftpMkdir: (serverId: string, path: string) => call<void>("sftp_mkdir", { serverId, path }),
  sftpCreateFile: (serverId: string, path: string) => call<void>("sftp_create_file", { serverId, path }),
  sftpRename: (serverId: string, from: string, to: string) => call<void>("sftp_rename", { serverId, from, to }),
  sftpDelete: (serverId: string, paths: string[], confirmed: boolean) => call<number>("sftp_delete", { serverId, paths, confirmed }),
  sftpCopy: (serverId: string, from: string, to: string) => call<void>("sftp_copy", { serverId, from, to }),
  sftpMove: (serverId: string, paths: string[], toDir: string) => call<string[]>("sftp_move", { serverId, paths, toDir }),
  sftpChmod: (serverId: string, path: string, mode: number) => call<void>("sftp_chmod", { serverId, path, mode }),
  sftpReadText: (serverId: string, path: string) => call<T.TextFile>("sftp_read_text", { serverId, path }),
  sftpWriteText: (serverId: string, path: string, content: string, encoding: string, expectedMtime: number | null) =>
    call<T.FileEntry>("sftp_write_text", { serverId, path, content, encoding, expectedMtime }),
  sftpSearch: (serverId: string, root: string, query: string) => call<T.FileEntry[]>("sftp_search", { serverId, root, query }),
  sftpDirSize: (serverId: string, path: string) => call<number>("sftp_dir_size", { serverId, path }),

  // local files
  localHome: () => call<string>("local_home"),
  localList: (path: string) => call<T.DirListing>("local_list", { path }),
  localStat: (path: string) => call<T.FileEntry>("local_stat", { path }),
  localMkdir: (dir: string, name: string) => call<string>("local_mkdir", { dir, name }),
  localCreateFile: (dir: string, name: string) => call<string>("local_create_file", { dir, name }),
  localRename: (path: string, newName: string) => call<string>("local_rename", { path, newName }),
  localDelete: (paths: string[], permanent: boolean, confirmed: boolean) => call<void>("local_delete", { paths, permanent, confirmed }),
  localCopy: (paths: string[], toDir: string) => call<string[]>("local_copy", { paths, toDir }),
  localMove: (paths: string[], toDir: string) => call<string[]>("local_move", { paths, toDir }),
  localSearch: (root: string, query: string) => call<T.FileEntry[]>("local_search", { root, query }),
  localOpen: (path: string) => call<void>("local_open", { path }),
  localReveal: (path: string) => call<void>("local_reveal", { path }),
  openUrl: (url: string) => call<void>("open_url", { url }),

  // transfers
  transferStart: (req: T.TransferRequest) => call<T.TransferInfo>("transfer_start", { req }),
  transferStartMany: (reqs: T.TransferRequest[]) => call<T.TransferInfo[]>("transfer_start_many", { reqs }),
  transfersList: () => call<T.TransferInfo[]>("transfers_list"),
  transferPause: (id: string) => call<void>("transfer_pause", { id }),
  transferResume: (id: string) => call<void>("transfer_resume", { id }),
  transferRetry: (id: string) => call<void>("transfer_retry", { id }),
  transferCancel: (id: string) => call<void>("transfer_cancel", { id }),
  transfersClearFinished: () => call<void>("transfers_clear_finished"),

  // monitoring & system
  monitorStart: (serverId: string, intervalMs: number) => call<void>("monitor_start", { serverId, intervalMs }),
  monitorStop: (serverId: string) => call<void>("monitor_stop", { serverId }),
  monitorHistory: (serverId: string) => call<T.MetricsSnapshot[]>("monitor_history", { serverId }),
  systemInfo: (serverId: string) => call<T.SystemInfo>("system_info", { serverId }),
  processesList: (serverId: string) => call<T.ProcessInfo[]>("processes_list", { serverId }),
  processDetails: (serverId: string, pid: number) => call<string>("process_details", { serverId, pid }),
  processSignal: (serverId: string, pid: number, signal: T.Signal, confirmed: boolean, sudoPassword?: string) =>
    call<void>("process_signal", { serverId, pid, signal, confirmed, sudoPassword: sudoPassword ?? null }),
  portsList: (serverId: string) => call<T.PortInfo[]>("ports_list", { serverId }),
  servicesList: (serverId: string) => call<T.ServiceInfo[]>("services_list", { serverId }),
  serviceStatus: (serverId: string, unit: string) => call<string>("service_status", { serverId, unit }),
  serviceAction: (serverId: string, unit: string, action: T.ServiceAction, confirmed: boolean, sudoPassword?: string) =>
    call<void>("service_action", { serverId, unit, action, confirmed, sudoPassword: sudoPassword ?? null }),
  sudoRemember: (serverId: string, password: string) => call<void>("sudo_remember", { serverId, password }),

  // docker
  dockerStatus: (serverId: string, refresh = false) => call<T.DockerStatus>("docker_status", { serverId, refresh }),
  dockerContainers: (serverId: string) => call<T.DockerContainer[]>("docker_containers", { serverId }),
  dockerImages: (serverId: string) => call<T.DockerImage[]>("docker_images", { serverId }),
  dockerVolumes: (serverId: string) => call<T.DockerVolume[]>("docker_volumes", { serverId }),
  dockerNetworks: (serverId: string) => call<T.DockerNetwork[]>("docker_networks", { serverId }),
  dockerStats: (serverId: string) => call<T.DockerStats[]>("docker_stats", { serverId }),
  dockerInspect: (serverId: string, id: string) => call<string>("docker_inspect", { serverId, id }),
  dockerContainerAction: (serverId: string, id: string, action: T.ContainerAction, confirmed: boolean) =>
    call<void>("docker_container_action", { serverId, id, action, confirmed }),
  dockerRemoveImage: (serverId: string, id: string, confirmed: boolean) => call<void>("docker_remove_image", { serverId, id, confirmed }),
  dockerRemoveVolume: (serverId: string, name: string, confirmed: boolean) => call<void>("docker_remove_volume", { serverId, name, confirmed }),
  dockerExecCommand: (serverId: string, id: string) => call<string>("docker_exec_command", { serverId, id }),

  // git
  gitDiscover: (serverId: string, root?: string) => call<string[]>("git_discover", { serverId, root: root ?? null }),
  gitStatus: (serverId: string, repo: string) => call<T.GitStatus>("git_status", { serverId, repo }),
  gitBranches: (serverId: string, repo: string) => call<T.GitBranch[]>("git_branches", { serverId, repo }),
  gitLog: (serverId: string, repo: string, limit: number, file?: string) => call<T.GitCommit[]>("git_log", { serverId, repo, limit, file: file ?? null }),
  gitDiff: (serverId: string, repo: string, file: string | null, staged: boolean) => call<string>("git_diff", { serverId, repo, file, staged }),
  gitShow: (serverId: string, repo: string, hash: string) => call<string>("git_show", { serverId, repo, hash }),
  gitAction: (serverId: string, repo: string, action: T.GitAction, confirmed: boolean) => call<string>("git_action", { serverId, repo, action, confirmed }),
  gitCheckout: (serverId: string, repo: string, branch: string, confirmed: boolean) => call<string>("git_checkout", { serverId, repo, branch, confirmed }),

  // logs
  logsStart: async (req: T.LogStreamRequest, onEvent: (e: T.StreamEvent) => void) => call<string>("logs_start", { req, onEvent: await chan(onEvent) }),
  logsStop: (id: string) => call<void>("logs_stop", { id }),
  logsDiscover: (serverId: string) => call<T.LogFileCandidate[]>("logs_discover", { serverId }),
  logsExport: (serverId: string, source: T.LogSource, sudo: boolean, localPath: string) => call<number>("logs_export", { serverId, source, sudo, localPath }),

  // tunnels
  tunnelsList: () => call<T.TunnelConfig[]>("tunnels_list"),
  tunnelStatuses: () => call<T.TunnelStatus[]>("tunnel_statuses"),
  tunnelSave: (id: string | null, input: T.TunnelInput) => call<T.TunnelConfig>("tunnel_save", { id, input }),
  tunnelDelete: (id: string) => call<void>("tunnel_delete", { id }),
  tunnelStart: (id: string) => call<T.TunnelStatus>("tunnel_start", { id }),
  tunnelStop: (id: string) => call<void>("tunnel_stop", { id }),

  // commands
  snippetsList: () => call<T.Snippet[]>("snippets_list"),
  snippetSave: (id: string | null, input: T.SnippetInput) => call<T.Snippet>("snippet_save", { id, input }),
  snippetDelete: (id: string) => call<void>("snippet_delete", { id }),
  commandAssess: (command: string) => call<T.CommandAssessment>("command_assess", { command }),
  commandRun: (serverId: string, command: string, confirmed: boolean) => call<T.ExecOutput>("command_run", { serverId, command, confirmed }),
  broadcastRun: (serverIds: string[], command: string, confirmed: boolean) => call<BroadcastRun>("broadcast_run", { serverIds, command, confirmed }),

  // workspaces, settings
  workspacesList: () => call<T.Workspace[]>("workspaces_list"),
  workspaceCreate: (name: string, serverIds: string[]) => call<T.Workspace>("workspace_create", { name, serverIds }),
  workspaceSave: (workspace: T.Workspace) => call<T.Workspace>("workspace_save", { workspace }),
  workspaceDelete: (id: string) => call<void>("workspace_delete", { id }),
  uiStateGet: (key: string) => call<string | null>("ui_state_get", { key }),
  uiStateSet: (key: string, value: string) => call<void>("ui_state_set", { key, value }),
  settingsGet: () => call<T.Settings>("settings_get"),
  settingsSave: (settings: T.Settings) => call<T.Settings>("settings_save", { settings }),

  // AI
  aiSetKey: (key: string | null) => call<T.Settings>("ai_set_key", { key }),
  aiNewChat: (serverId: string) => call<string>("ai_new_chat", { serverId }),
  aiSend: (chatId: string, text: string) => call<T.AiTurnResult>("ai_send", { chatId, text }),
  aiDecide: (chatId: string, proposalId: string, approve: boolean) => call<T.AiTurnResult>("ai_decide", { chatId, proposalId, approve }),
  aiDeleteChat: (chatId: string) => call<void>("ai_delete_chat", { chatId }),

  // app
  appInfo: () => call<AppInfo>("app_info"),
  appQuit: () => call<void>("app_quit"),
};

export type Api = typeof api;
