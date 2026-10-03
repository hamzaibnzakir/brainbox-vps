/**
 * Native platform features (window, clipboard, dialogs, updater, drag & drop)
 * with browser fallbacks for mock mode.
 */
import { getBackend, isTauri } from "./backend";

async function tauriWin() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

async function real(): Promise<boolean> {
  return (await getBackend()).kind === "tauri" && isTauri;
}

export const platform = {
  async minimize() {
    if (await real()) (await tauriWin()).minimize();
  },
  async toggleMaximize() {
    if (await real()) (await tauriWin()).toggleMaximize();
  },
  async close() {
    if (await real()) (await tauriWin()).close();
  },
  async isMaximized(): Promise<boolean> {
    return (await real()) ? (await tauriWin()).isMaximized() : false;
  },
  async onResized(cb: () => void): Promise<() => void> {
    if (!(await real())) return () => {};
    return (await tauriWin()).onResized(cb);
  },
  async setFullscreen(on: boolean) {
    if (await real()) (await tauriWin()).setFullscreen(on);
    else if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  },

  async readClipboard(): Promise<string> {
    if (await real()) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return (await readText()) ?? "";
    }
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  },
  async writeClipboard(text: string) {
    if (await real()) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  },

  async openDialog(opts: { multiple?: boolean; directory?: boolean; title?: string; defaultPath?: string }): Promise<string[] | null> {
    if (!(await real())) {
      const v = window.prompt(opts.title ?? "Path", opts.defaultPath ?? "");
      return v ? [v] : null;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ multiple: !!opts.multiple, directory: !!opts.directory, title: opts.title, defaultPath: opts.defaultPath });
    if (r === null) return null;
    return Array.isArray(r) ? r : [r];
  },
  async saveDialog(opts: { title?: string; defaultPath?: string }): Promise<string | null> {
    if (!(await real())) return window.prompt(opts.title ?? "Save as", opts.defaultPath ?? "") || null;
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save({ title: opts.title, defaultPath: opts.defaultPath });
  },

  /** OS file drops onto the window (paths + position in CSS px). */
  async onFileDrop(cb: (e: { type: "enter" | "over" | "drop" | "leave"; paths: string[]; x: number; y: number }) => void): Promise<() => void> {
    if (!(await real())) return () => {};
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
      const ratio = window.devicePixelRatio || 1;
      cb({
        type: p.type as "enter" | "over" | "drop" | "leave",
        paths: p.paths ?? [],
        x: (p.position?.x ?? 0) / ratio,
        y: (p.position?.y ?? 0) / ratio,
      });
    });
  },

  async checkForUpdate(): Promise<{ version: string; notes: string; install: () => Promise<void> } | null> {
    if (!(await real())) return null;
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check();
    if (!u) return null;
    return {
      version: u.version,
      notes: u.body ?? "",
      install: async () => {
        await u.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  },
};
