import { useEffect, useState } from "react";
import { Bell, Bot, Download, Info, KeyRound, Monitor, Palette, Rocket, Shield, SquareTerminal, FolderTree, Activity, Keyboard, Check } from "lucide-react";
import type { Settings } from "@/types/generated";
import { api, type AppInfo } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { useSettings } from "@/stores/settings";
import { toastError, useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Badge, Button, Field, Input, Kbd, Segmented, Select, Switch } from "@/components/ui";
import { cn } from "@/lib/format";
import { refreshAllTerminals } from "../terminal/registry";

type Section = "appearance" | "terminal" | "files" | "monitoring" | "notifications" | "security" | "ai" | "system" | "shortcuts" | "about";

const ACCENTS = ["#7c5cff", "#6366f1", "#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#f59e0b", "#f97316", "#ef4444", "#ec4899"];

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-6 py-3.5 border-b border-line/70">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-fg">{title}</div>
        {desc && <div className="text-[12px] text-fg-3 mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+K / Ctrl+Shift+P", "Command palette"],
  ["Ctrl+P", "Quick server search"],
  ["Ctrl+Shift+T", "New terminal on the selected server"],
  ["Ctrl+Shift+L", "New local terminal"],
  ["Ctrl+Shift+F", "File manager"],
  ["Ctrl+Shift+B", "Broadcast"],
  ["Ctrl+Shift+D / Ctrl+Shift+E", "Split terminal right / down"],
  ["Ctrl+Shift+X", "Close terminal pane"],
  ["Ctrl+Alt+F", "Find in terminal"],
  ["Ctrl+C (with selection) / Ctrl+Shift+C", "Copy from terminal"],
  ["Ctrl+V / Shift+Insert / right-click", "Paste into terminal"],
  ["F11", "Fullscreen terminal"],
  ["Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab"],
  ["Ctrl+1 … Ctrl+9", "Go to tab"],
  ["Ctrl+W (outside terminals) / Ctrl+F4", "Close tab"],
  ["Ctrl+Shift+W", "Close all tabs in the workspace"],
  ["Ctrl+B", "Toggle sidebar"],
  ["Ctrl+J", "Toggle transfers"],
  ["Ctrl+I", "Toggle Brainbox AI"],
  ["Ctrl+,", "Settings"],
  ["F2 / F5 / F7 / Del", "Rename / transfer / new folder / delete (file manager)"],
];

export function SettingsView() {
  const { settings, update } = useSettings();
  const [section, setSection] = useState<Section>("appearance");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => void api.appInfo().then(setInfo), []);
  const up = async (patch: Partial<Settings>) => {
    try {
      await update(patch);
      if (Object.keys(patch).some((k) => k.startsWith("terminal") || k === "theme" || k === "accent")) setTimeout(refreshAllTerminals, 30);
    } catch (e) {
      toastError(toAppError(e));
    }
  };
  const s = settings;
  const nav: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
    { id: "appearance", label: "Appearance", icon: <Palette size={14} /> },
    { id: "terminal", label: "Terminal", icon: <SquareTerminal size={14} /> },
    { id: "files", label: "Files & transfers", icon: <FolderTree size={14} /> },
    { id: "monitoring", label: "Monitoring", icon: <Activity size={14} /> },
    { id: "notifications", label: "Notifications", icon: <Bell size={14} /> },
    { id: "security", label: "Security", icon: <Shield size={14} /> },
    { id: "ai", label: "Brainbox AI", icon: <Bot size={14} /> },
    { id: "system", label: "Startup & updates", icon: <Rocket size={14} /> },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={14} /> },
    { id: "about", label: "About", icon: <Info size={14} /> },
  ];

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const u = await platform.checkForUpdate();
      if (!u) useUi.getState().toast({ kind: "success", title: "You're up to date" });
      else if (await useUi.getState().confirm({ title: `Update to ${u.version}?`, message: u.notes || "A new version of Brainbox VPS is available.", confirmLabel: "Install & restart" })) await u.install();
    } catch (e) {
      useUi.getState().toast({ kind: "warning", title: "Couldn't check for updates", body: toAppError(e).details ?? String(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-[220px] shrink-0 border-r border-line bg-bg-1 p-3 space-y-0.5" aria-label="Settings sections">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-3 px-2 pb-2">Settings</div>
        {nav.map((n) => (
          <button key={n.id} onClick={() => setSection(n.id)} className={cn("w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[12.5px]", section === n.id ? "bg-accent-soft text-fg font-medium" : "text-fg-3 hover:text-fg hover:bg-bg-3")} data-testid={`settings-${n.id}`}>
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-auto">
        <div className="max-w-[760px] px-8 py-6">
          {section === "appearance" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Appearance</h2>
              <Row title="Theme">
                <Segmented value={s.theme} onChange={(v) => void up({ theme: v })} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
              </Row>
              <Row title="Accent color" desc="Used for highlights, focus and the terminal cursor.">
                <div className="flex items-center gap-1.5">
                  {ACCENTS.map((c) => (
                    <button key={c} onClick={() => void up({ accent: c })} className="h-6 w-6 rounded-full flex items-center justify-center transition-transform hover:scale-110" style={{ background: c }} aria-label={`Accent ${c}`}>
                      {s.accent.toLowerCase() === c && <Check size={13} className="text-white" />}
                    </button>
                  ))}
                  <label className="h-6 w-6 rounded-full border border-line-2 overflow-hidden relative cursor-pointer" title="Custom color">
                    <input type="color" value={s.accent} onChange={(e) => void up({ accent: e.target.value })} className="absolute -inset-2 w-10 h-10 cursor-pointer" />
                  </label>
                </div>
              </Row>
              <Row title="Density" desc="Compact fits more rows on screen.">
                <Segmented value={s.density} onChange={(v) => void up({ density: v })} options={[{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }]} />
              </Row>
              <Row title="Interface font size">
                <Select value={String(s.uiFontSize)} onChange={(e) => void up({ uiFontSize: Number(e.target.value) })}>
                  {[12, 13, 14, 15].map((n) => (
                    <option key={n} value={n}>
                      {n}px
                    </option>
                  ))}
                </Select>
              </Row>
            </>
          )}
          {section === "terminal" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Terminal</h2>
              <Row title="Font family">
                <Input value={s.terminalFontFamily} onChange={(e) => void up({ terminalFontFamily: e.target.value })} className="w-72 font-mono text-[12px]" />
              </Row>
              <Row title="Font size">
                <Input type="number" min={8} max={36} value={s.terminalFontSize} onChange={(e) => void up({ terminalFontSize: Number(e.target.value) })} className="w-20" />
              </Row>
              <Row title="Line height">
                <Select value={String(s.terminalLineHeight)} onChange={(e) => void up({ terminalLineHeight: Number(e.target.value) })}>
                  {[1, 1.1, 1.2, 1.3, 1.4, 1.5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row title="Cursor">
                <div className="flex items-center gap-3">
                  <Segmented value={s.terminalCursorStyle} onChange={(v) => void up({ terminalCursorStyle: v })} options={[{ value: "bar", label: "Bar" }, { value: "block", label: "Block" }, { value: "underline", label: "Underline" }]} />
                  <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
                    <Switch checked={s.terminalCursorBlink} onChange={(v) => void up({ terminalCursorBlink: v })} /> Blink
                  </label>
                </div>
              </Row>
              <Row title="Scrollback lines">
                <Input type="number" min={500} max={200000} step={1000} value={s.terminalScrollback} onChange={(e) => void up({ terminalScrollback: Number(e.target.value) })} className="w-28" />
              </Row>
              <Row title="Right-click pastes" desc="Right-click copies a selection or pastes (like PuTTY). Shift+right-click opens the menu.">
                <Switch checked={s.rightClickPaste} onChange={(v) => void up({ rightClickPaste: v })} />
              </Row>
              <Row title="Copy on select">
                <Switch checked={s.copyOnSelect} onChange={(v) => void up({ copyOnSelect: v })} />
              </Row>
              <Row title="Confirm multi-line paste" desc="Ask before pasting text that would run several commands.">
                <Switch checked={s.confirmMultilinePaste} onChange={(v) => void up({ confirmMultilinePaste: v })} />
              </Row>
              <Row title="Use tmux for new servers" desc="Default for persistent sessions when adding a server.">
                <Switch checked={s.defaultUseTmux} onChange={(v) => void up({ defaultUseTmux: v })} />
              </Row>
            </>
          )}
          {section === "files" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Files & transfers</h2>
              <Row title="Show hidden files by default">
                <Switch checked={s.showHiddenFiles} onChange={(v) => void up({ showHiddenFiles: v })} />
              </Row>
              <Row title="Parallel transfers" desc="How many uploads/downloads run at the same time.">
                <Select value={String(s.transferConcurrency)} onChange={(e) => void up({ transferConcurrency: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 6, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row title="Editor font size">
                <Input type="number" min={9} max={28} value={s.editorFontSize} onChange={(e) => void up({ editorFontSize: Number(e.target.value) })} className="w-20" />
              </Row>
              <Row title="Editor minimap">
                <Switch checked={s.editorMinimap} onChange={(v) => void up({ editorMinimap: v })} />
              </Row>
              <Row title="Editor word wrap">
                <Switch checked={s.editorWordWrap} onChange={(v) => void up({ editorWordWrap: v })} />
              </Row>
            </>
          )}
          {section === "monitoring" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Monitoring</h2>
              <p className="text-[12.5px] text-fg-3 mb-2">Brainbox reads /proc and df with one lightweight command per refresh — no agents are installed on your servers.</p>
              <Row title="Dashboard refresh interval" desc="While a server's Overview is visible.">
                <Select value={String(s.monitorIntervalMs)} onChange={(e) => void up({ monitorIntervalMs: Number(e.target.value) })}>
                  {[1000, 2000, 5000, 10000, 30000].map((n) => (
                    <option key={n} value={n}>
                      {n / 1000}s
                    </option>
                  ))}
                </Select>
              </Row>
              <Row title="Background refresh interval" desc="For the sidebar's CPU/RAM/disk bars on connected servers.">
                <Select value={String(s.backgroundMonitorIntervalMs)} onChange={(e) => void up({ backgroundMonitorIntervalMs: Number(e.target.value) })}>
                  {[5000, 15000, 30000, 60000, 300000].map((n) => (
                    <option key={n} value={n}>
                      {n >= 60000 ? `${n / 60000} min` : `${n / 1000}s`}
                    </option>
                  ))}
                </Select>
              </Row>
            </>
          )}
          {section === "notifications" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Notifications</h2>
              <Row title="Desktop notifications" desc="Shown when Brainbox is in the background.">
                <Switch checked={s.notifications.enabled} onChange={(v) => void up({ notifications: { ...s.notifications, enabled: v } })} />
              </Row>
              {(
                [
                  ["sshDisconnected", "SSH disconnected"],
                  ["sshReconnected", "SSH reconnected"],
                  ["serverUnreachable", "Server unreachable"],
                  ["transferFinished", "Long upload/download finished"],
                  ["containerStopped", "Docker container stopped"],
                  ["commandFinished", "Long command finished"],
                ] as const
              ).map(([k, l]) => (
                <Row key={k} title={l}>
                  <Switch checked={s.notifications[k]} disabled={!s.notifications.enabled} onChange={(v) => void up({ notifications: { ...s.notifications, [k]: v } })} />
                </Row>
              ))}
              <Row title="“Long” means at least" desc="For transfers and commands.">
                <Select value={String(s.notifications.minDurationSecs)} onChange={(e) => void up({ notifications: { ...s.notifications, minDurationSecs: Number(e.target.value) } })}>
                  {[0, 5, 10, 30, 60, 300].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "always" : n >= 60 ? `${n / 60} min` : `${n}s`}
                    </option>
                  ))}
                </Select>
              </Row>
            </>
          )}
          {section === "security" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Security</h2>
              <Row title="Credential storage" desc="Passwords, key passphrases, imported keys and API keys are encrypted with AES-256-GCM. The master key is protected by Windows (Credential Manager / DPAPI).">
                <Badge tone="ok">{info?.vaultBackend ?? "…"}</Badge>
              </Row>
              <Row title="Confirm risky commands" desc="Ask before broadcasting or running commands that change servers. Destructive commands always require confirmation.">
                <Switch checked={s.confirmDangerousCommands} onChange={(v) => void up({ confirmDangerousCommands: v })} />
              </Row>
              <Row title="Trusted server keys" desc="Host keys you have verified.">
                <Button size="sm" icon={<KeyRound size={13} />} onClick={() => useWorkspace.getState().openTab("known-hosts")}>
                  Manage known hosts
                </Button>
              </Row>
            </>
          )}
          {section === "ai" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-1">Brainbox AI</h2>
              <p className="text-[12.5px] text-fg-3 mb-3 leading-relaxed">The assistant inspects servers with read-only tools. Anything that changes a server is shown to you as an exact command that you approve first. Server output is sent to the provider you choose; obvious secrets are redacted and secret files are never read.</p>
              <Row title="Enable Brainbox AI">
                <Switch checked={s.ai.enabled} onChange={(v) => void up({ ai: { ...s.ai, enabled: v } })} />
              </Row>
              <Row title="Provider">
                <Segmented
                  value={s.ai.provider}
                  onChange={(v) => void up({ ai: { ...s.ai, provider: v, baseUrl: v === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1", model: v === "anthropic" ? "claude-sonnet-5-5" : "gpt-4.1" } })}
                  options={[{ value: "anthropic", label: "Anthropic" }, { value: "openai_compatible", label: "OpenAI-compatible" }]}
                />
              </Row>
              <div className="grid grid-cols-2 gap-3 py-3.5 border-b border-line/70">
                <Field label="API base URL" hint={s.ai.provider === "openai_compatible" ? "Works with OpenAI, OpenRouter, Ollama (http://localhost:11434/v1), LM Studio…" : undefined}>
                  <Input mono value={s.ai.baseUrl} onChange={(e) => void up({ ai: { ...s.ai, baseUrl: e.target.value } })} />
                </Field>
                <Field label="Model">
                  <Input mono value={s.ai.model} onChange={(e) => void up({ ai: { ...s.ai, model: e.target.value } })} />
                </Field>
              </div>
              <Row title="API key" desc={s.ai.hasApiKey ? "A key is saved (encrypted)." : "Required for hosted providers."}>
                <div className="flex gap-2">
                  <Input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder={s.ai.hasApiKey ? "••••••••  (replace)" : "sk-…"} className="w-56" />
                  <Button
                    size="md"
                    variant="primary"
                    disabled={!aiKey}
                    onClick={async () => {
                      useSettings.getState().replace(await api.aiSetKey(aiKey));
                      setAiKey("");
                      useUi.getState().toast({ kind: "success", title: "API key saved" });
                    }}
                  >
                    Save
                  </Button>
                  {s.ai.hasApiKey && (
                    <Button size="md" variant="ghost" onClick={async () => useSettings.getState().replace(await api.aiSetKey(null))}>
                      Remove
                    </Button>
                  )}
                </div>
              </Row>
              <Row title="Run read-only checks automatically" desc="When off, every command the assistant wants to run needs your approval.">
                <Switch checked={s.ai.autoRunReadOnly} onChange={(v) => void up({ ai: { ...s.ai, autoRunReadOnly: v } })} />
              </Row>
            </>
          )}
          {section === "system" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-2">Startup & updates</h2>
              <Row title="Launch at Windows startup" desc="Starts minimized to the tray.">
                <Switch checked={s.launchAtStartup} onChange={(v) => void up({ launchAtStartup: v })} />
              </Row>
              <Row title="Close to tray" desc="Closing the window keeps Brainbox (and your tunnels and transfers) running in the system tray.">
                <Switch checked={s.closeToTray} onChange={(v) => void up({ closeToTray: v })} />
              </Row>
              <Row title="Restore workspace on start" desc="Re-open tabs and terminals (tmux sessions re-attach automatically).">
                <Switch checked={s.restoreWorkspace} onChange={(v) => void up({ restoreWorkspace: v })} />
              </Row>
              <Row title="Check for updates automatically">
                <Switch checked={s.checkUpdates} onChange={(v) => void up({ checkUpdates: v })} />
              </Row>
              <Row title="Updates">
                <Button size="sm" icon={<Download size={13} />} loading={checking} onClick={() => void checkUpdates()}>
                  Check now
                </Button>
              </Row>
            </>
          )}
          {section === "shortcuts" && (
            <>
              <h2 className="text-[17px] font-semibold text-fg mb-3">Keyboard shortcuts</h2>
              <p className="text-[12.5px] text-fg-3 mb-3">Inside terminals, Ctrl+letter keys go to the shell (Ctrl+W deletes a word, Ctrl+K kills a line…). App shortcuts use Ctrl+Shift.</p>
              <div className="rounded-lg border border-line divide-y divide-line">
                {SHORTCUTS.map(([k, l]) => (
                  <div key={k} className="flex items-center justify-between px-3 h-9 text-[12.5px] text-fg-2">
                    {l}
                    <span className="flex gap-2">
                      {k.split(" / ").map((c) => (
                        <Kbd key={c} chord={c.replace(/ \(.*\)/, "").replace(" … ", "…")} />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {section === "about" && (
            <>
              <div className="flex items-center gap-4 mb-6">
                <img src="/logo.svg" alt="" className="h-14 w-14" />
                <div>
                  <h2 className="text-[20px] font-semibold text-fg">Brainbox VPS</h2>
                  <p className="text-[12.5px] text-fg-3">Version {info?.version ?? "…"} · Tauri 2 · Rust · React</p>
                </div>
              </div>
              <Row title="Data folder" desc={<span className="font-mono">{info?.dataDir}</span>}>
                <Button size="sm" icon={<Monitor size={13} />} onClick={() => info && void api.localOpen(info.dataDir)}>
                  Open
                </Button>
              </Row>
              <p className="text-[12px] text-fg-4 mt-4">Built on open-source components including russh, xterm.js and Monaco. Portions of the low-level SSH approach were informed by the MIT-licensed Wrolp project.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
