/**
 * Server actions shared by the sidebar, palette, home and menus.
 */
import { Copy, Edit3, FolderTree, LayoutDashboard, Pencil, Plug, PlugZap, Star, StarOff, Terminal, Trash2, Unplug, FolderInput } from "lucide-react";
import { platform } from "@/services/platform";
import type { AppError, ServerProfile } from "@/types/generated";
import { api } from "@/services/api";
import { errorIs, toAppError } from "@/services/errors";
import { connState, useServers } from "@/stores/servers";
import { toastError, useUi } from "@/stores/ui";
import { useWorkspace, type TabKind } from "@/stores/workspace";
import type { MenuItem } from "@/components/ContextMenu";

const inflight = new Map<string, Promise<boolean>>();

/** Connect with interactive password/passphrase prompts. Returns success. */
export function connectServer(serverId: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const existing = inflight.get(serverId);
  if (existing) return existing;
  const p = doConnect(serverId, opts).finally(() => inflight.delete(serverId));
  inflight.set(serverId, p);
  return p;
}

async function doConnect(serverId: string, opts: { quiet?: boolean }): Promise<boolean> {
  if (connState(serverId) === "connected") return true;
  const server = useServers.getState().servers.find((s) => s.id === serverId);
  const ui = useUi.getState();
  let password: string | undefined;
  let passphrase: string | undefined;
  let save = false;
  let lastErr: AppError | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await api.connect(serverId, { password, passphrase, save });
      if (save) void useServers.getState().load();
      return true;
    } catch (e) {
      const err = toAppError(e);
      lastErr = err;
      const name = server ? `${server.username}@${server.host}` : "this server";
      if (errorIs(err, "need_password") || (errorIs(err, "auth_failed") && password !== undefined)) {
        const r = await ui.prompt({
          title: `Password for ${server?.name ?? "server"}`,
          message: errorIs(err, "auth_failed") ? <span className="text-danger">That password was rejected. Try again.</span> : <>Enter the SSH password for <span className="font-mono text-fg">{name}</span>.</>,
          label: "Password",
          password: true,
          confirmLabel: "Connect",
          checkbox: "Save password (encrypted on this computer)",
        });
        if (!r) return false;
        password = r.value;
        save = r.checked;
        continue;
      }
      if (errorIs(err, "need_passphrase", "bad_passphrase")) {
        const r = await ui.prompt({
          title: "Key passphrase",
          message: errorIs(err, "bad_passphrase") ? <span className="text-danger">Wrong passphrase. Try again.</span> : "This private key is protected by a passphrase.",
          label: "Passphrase",
          password: true,
          confirmLabel: "Unlock",
          checkbox: "Remember passphrase (encrypted on this computer)",
        });
        if (!r) return false;
        passphrase = r.value;
        save = r.checked;
        continue;
      }
      if (errorIs(err, "host_key_rejected")) return false;
      break;
    }
  }
  if (lastErr && !opts.quiet) {
    if (errorIs(lastErr, "host_key_mismatch")) void ui.showError(lastErr);
    else toastError(lastErr, { label: "Retry", run: () => void connectServer(serverId) });
  }
  return false;
}

export async function disconnectServer(serverId: string) {
  await api.disconnect(serverId);
}

/** Open a server tool tab, connecting first if needed. */
export async function openTool(serverId: string, kind: TabKind, data: Record<string, unknown> = {}, newTab = false) {
  const ws = useWorkspace.getState();
  ws.selectServer(serverId);
  if (kind !== "tunnels" && kind !== "commands" && connState(serverId) !== "connected") {
    // Open the tab immediately (it shows a connecting state) and connect.
    const id = ws.openTab(kind, serverId, data, { newTab });
    void connectServer(serverId);
    return id;
  }
  return ws.openTab(kind, serverId, data, { newTab });
}

/** Run `fn`, asking for the sudo password if the server requires it. */
export async function withSudo<T>(serverId: string, fn: (pw?: string) => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    let err = toAppError(e);
    for (let i = 0; i < 3 && errorIs(err, "sudo_password_required"); i++) {
      const r = await useUi.getState().prompt({
        title: err.title,
        message: err.message,
        label: "sudo password",
        password: true,
        confirmLabel: "Continue",
        checkbox: "Remember for this session",
      });
      if (!r) throw { ...err, code: "cancelled", title: "Cancelled", message: "The action was cancelled." } satisfies AppError;
      try {
        const out = await fn(r.value);
        if (r.checked) await api.sudoRemember(serverId, r.value);
        return out;
      } catch (e2) {
        err = toAppError(e2);
      }
    }
    throw err;
  }
}

export async function deleteServer(s: ServerProfile) {
  const ok = await useUi.getState().confirm({
    title: `Delete “${s.name}”?`,
    message: "The server profile, its saved credentials, tunnels and server-specific commands will be removed from this computer. Nothing on the server is changed.",
    confirmLabel: "Delete server",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.serverDelete(s.id);
    useServers.getState().remove(s.id);
    const ws = useWorkspace.getState();
    for (const t of ws.tabs.filter((t) => t.serverId === s.id)) await ws.closeTab(t.id, true);
    useUi.getState().toast({ kind: "success", title: `Deleted ${s.name}` });
  } catch (e) {
    toastError(toAppError(e));
  }
}

export async function renameServer(s: ServerProfile) {
  const r = await useUi.getState().prompt({ title: "Rename server", label: "Name", initial: s.name, confirmLabel: "Rename", validate: (v) => (v.trim() ? null : "Enter a name") });
  if (!r) return;
  try {
    useServers.getState().upsert(await api.serverRename(s.id, r.value.trim()));
  } catch (e) {
    toastError(toAppError(e));
  }
}

export async function duplicateServer(s: ServerProfile) {
  try {
    const c = await api.serverDuplicate(s.id);
    useServers.getState().upsert(c);
    useUi.getState().toast({ kind: "success", title: `Created ${c.name}` });
  } catch (e) {
    toastError(toAppError(e));
  }
}

export async function toggleFavorite(s: ServerProfile) {
  try {
    useServers.getState().upsert(await api.serverSetFavorite(s.id, !s.favorite));
  } catch (e) {
    toastError(toAppError(e));
  }
}

export async function moveToGroup(s: ServerProfile) {
  const groups = [...new Set(useServers.getState().servers.map((x) => x.group).filter(Boolean))] as string[];
  const r = await useUi.getState().prompt({ title: "Move to group", label: "Group name (empty for none)", initial: s.group ?? "", placeholder: groups.join(", ") || "e.g. Production", confirmLabel: "Move" });
  if (!r) return;
  await api.serversSetGroup([s.id], r.value.trim() || null);
  await useServers.getState().load();
}

export function serverMenu(s: ServerProfile): MenuItem[] {
  const st = connState(s.id);
  const connected = st === "connected";
  return [
    { type: "header", label: s.name },
    connected
      ? { label: "Disconnect", icon: <Unplug size={14} />, onClick: () => void disconnectServer(s.id) }
      : { label: st === "connecting" || st === "reconnecting" ? "Connecting…" : "Connect", icon: <Plug size={14} />, disabled: st === "connecting", onClick: () => void connectServer(s.id) },
    { type: "separator" },
    { label: "Open terminal", icon: <Terminal size={14} />, shortcut: "Ctrl+Shift+T", onClick: () => void openTool(s.id, "terminal", {}, true) },
    { label: "Open files", icon: <FolderTree size={14} />, shortcut: "Ctrl+Shift+F", onClick: () => void openTool(s.id, "files") },
    { label: "Overview", icon: <LayoutDashboard size={14} />, onClick: () => void openTool(s.id, "overview") },
    { type: "separator" },
    { label: s.favorite ? "Remove from favorites" : "Add to favorites", icon: s.favorite ? <StarOff size={14} /> : <Star size={14} />, onClick: () => void toggleFavorite(s) },
    { label: "Edit…", icon: <Edit3 size={14} />, onClick: () => useUi.getState().openServerEditor(s.id) },
    { label: "Rename…", icon: <Pencil size={14} />, onClick: () => void renameServer(s) },
    { label: "Duplicate", icon: <Copy size={14} />, onClick: () => void duplicateServer(s) },
    { label: "Move to group…", icon: <FolderInput size={14} />, onClick: () => void moveToGroup(s) },
    { label: "Copy address", icon: <PlugZap size={14} />, onClick: () => void platform.writeClipboard(`${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`) },
    { type: "separator" },
    { label: "Delete…", icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteServer(s) },
  ];
}
