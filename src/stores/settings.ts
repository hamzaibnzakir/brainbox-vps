import { create } from "zustand";
import type { Settings } from "@/types/generated";
import { api } from "@/services/api";
import { defaultSettings } from "@/services/mock/data";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<Settings>;
  replace: (s: Settings) => void;
}

let systemDark = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : null;

export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  const theme = s.theme === "system" ? (systemDark?.matches ? "dark" : "light") : s.theme;
  root.dataset.theme = theme;
  root.dataset.density = s.density;
  root.style.setProperty("--accent", s.accent || "#7c5cff");
  root.style.setProperty("--ui-font-size", `${s.uiFontSize || 13}px`);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: defaultSettings(),
  loaded: false,
  load: async () => {
    const s = await api.settingsGet();
    applyAppearance(s);
    set({ settings: s, loaded: true });
  },
  update: async (patch) => {
    const next = { ...get().settings, ...patch };
    applyAppearance(next);
    set({ settings: next });
    const saved = await api.settingsSave(next);
    set({ settings: saved });
    return saved;
  },
  replace: (s) => {
    applyAppearance(s);
    set({ settings: s });
  },
}));

if (systemDark) {
  systemDark.addEventListener?.("change", () => applyAppearance(useSettings.getState().settings));
} else {
  systemDark = null;
}
