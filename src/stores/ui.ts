import { create } from "zustand";
import type { AppError, HostKeyDecision, HostKeyPrompt } from "@/types/generated";
import type { ReactNode } from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  error?: AppError;
  action?: { label: string; run: () => void };
  timeout: number;
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Text the user must type to confirm (for very destructive actions). */
  requireText?: string;
  details?: string[];
  command?: string;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  label?: string;
  placeholder?: string;
  initial?: string;
  password?: boolean;
  confirmLabel?: string;
  checkbox?: string;
  validate?: (v: string) => string | null;
}

export interface PromptResult {
  value: string;
  checked: boolean;
}

type Dialog =
  | { id: string; type: "confirm"; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { id: string; type: "prompt"; opts: PromptOptions; resolve: (r: PromptResult | null) => void }
  | { id: string; type: "error"; error: AppError; resolve: () => void }
  | { id: string; type: "custom"; render: (close: (v?: unknown) => void) => ReactNode; resolve: (v: unknown) => void };

export type PaletteMode = "commands" | "servers" | "files";

export type BottomTab = "transfers" | "output";

interface UiState {
  toasts: Toast[];
  dialogs: Dialog[];
  hostKeys: HostKeyPrompt[];
  palette: { open: boolean; mode: PaletteMode; query: string };
  sidebarVisible: boolean;
  sidebarWidth: number;
  bottomOpen: boolean;
  bottomTab: BottomTab;
  bottomHeight: number;
  aiOpen: boolean;
  aiWidth: number;
  serverEditor: { open: boolean; serverId: string | null; duplicateOf?: string | null };
  importOpen: boolean;

  toast: (t: Omit<Toast, "id" | "timeout"> & { timeout?: number }) => string;
  dismissToast: (id: string) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<PromptResult | null>;
  showError: (e: AppError) => Promise<void>;
  custom: <T>(render: (close: (v?: T) => void) => ReactNode) => Promise<T | undefined>;
  closeDialog: (id: string) => void;
  pushHostKey: (p: HostKeyPrompt) => void;
  popHostKey: (requestId: string, d: HostKeyDecision) => void;
  openPalette: (mode?: PaletteMode, query?: string) => void;
  closePalette: () => void;
  set: (patch: Partial<Pick<UiState, "sidebarVisible" | "sidebarWidth" | "bottomOpen" | "bottomTab" | "bottomHeight" | "aiOpen" | "aiWidth" | "importOpen">>) => void;
  openServerEditor: (serverId?: string | null) => void;
  closeServerEditor: () => void;
}

let seq = 0;
const nid = () => `${Date.now().toString(36)}-${++seq}`;

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  dialogs: [],
  hostKeys: [],
  palette: { open: false, mode: "commands", query: "" },
  sidebarVisible: true,
  sidebarWidth: 272,
  bottomOpen: false,
  bottomTab: "transfers",
  bottomHeight: 240,
  aiOpen: false,
  aiWidth: 400,
  serverEditor: { open: false, serverId: null },
  importOpen: false,

  toast: (t) => {
    const id = nid();
    const toast: Toast = { timeout: t.kind === "error" ? 8000 : 4000, ...t, id };
    set({ toasts: [...get().toasts.slice(-4), toast] });
    if (toast.timeout > 0) setTimeout(() => get().dismissToast(id), toast.timeout);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  confirm: (opts) =>
    new Promise((resolve) => {
      const id = nid();
      set({ dialogs: [...get().dialogs, { id, type: "confirm", opts, resolve }] });
    }),
  prompt: (opts) =>
    new Promise((resolve) => {
      const id = nid();
      set({ dialogs: [...get().dialogs, { id, type: "prompt", opts, resolve }] });
    }),
  showError: (error) =>
    new Promise((resolve) => {
      const id = nid();
      set({ dialogs: [...get().dialogs, { id, type: "error", error, resolve }] });
    }),
  custom: <T,>(render: (close: (v?: T) => void) => ReactNode) =>
    new Promise<T | undefined>((resolve) => {
      const id = nid();
      set({ dialogs: [...get().dialogs, { id, type: "custom", render: render as (c: (v?: unknown) => void) => ReactNode, resolve: resolve as (v: unknown) => void }] });
    }),
  closeDialog: (id) => set({ dialogs: get().dialogs.filter((d) => d.id !== id) }),
  pushHostKey: (p) => set({ hostKeys: [...get().hostKeys.filter((h) => h.requestId !== p.requestId), p] }),
  popHostKey: (requestId) => set({ hostKeys: get().hostKeys.filter((h) => h.requestId !== requestId) }),
  openPalette: (mode = "commands", query = "") => set({ palette: { open: true, mode, query } }),
  closePalette: () => set({ palette: { ...get().palette, open: false } }),
  set: (patch) => set(patch),
  openServerEditor: (serverId = null) => set({ serverEditor: { open: true, serverId } }),
  closeServerEditor: () => set({ serverEditor: { open: false, serverId: null } }),
}));

export type { Dialog };

/** Toast helper for errors from commands. */
export function toastError(e: AppError, action?: Toast["action"]) {
  useUi.getState().toast({ kind: "error", title: e.title, body: e.message, error: e, action });
}
