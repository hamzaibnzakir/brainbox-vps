import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, FileKey2, FolderOpen, KeyRound, Lock, Server, ShieldCheck, Star, Network, Rocket, StickyNote } from "lucide-react";
import type { AuthMethod, ProxyKind, SecretUpdate, ServerInput, ServerProfile } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { useServers } from "@/stores/servers";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Modal } from "@/components/Modal";
import { Button, Field, Input, Segmented, Select, Switch, Textarea } from "@/components/ui";
import { ErrorView } from "@/components/ErrorView";
import { cn } from "@/lib/format";
import { connectServer, openTool } from "./actions";
import type { AppError } from "@/types/generated";

const COLORS = ["#7c5cff", "#3b82f6", "#06b6d4", "#22c55e", "#eab308", "#f59e0b", "#ef4444", "#ec4899", "#a855f7", "#64748b"];

type Section = "general" | "auth" | "connection" | "advanced";

function SecretInput({ has, value, onChange, placeholder, label }: { has: boolean; value: SecretUpdate; onChange: (v: SecretUpdate) => void; placeholder?: string; label: string }) {
  const [show, setShow] = useState(false);
  const editing = value.action === "set" || !has;
  if (!editing)
    return (
      <div className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-line-2 bg-bg-1 text-[12.5px]">
        <Lock size={13} className="text-ok" />
        <span className="text-fg-2 flex-1">{label} saved (encrypted)</span>
        <button className="text-accent text-[12px] hover:underline" onClick={() => onChange({ action: "set", value: "" })}>
          Change
        </button>
        <button className="text-danger text-[12px] hover:underline" onClick={() => onChange({ action: "clear" })}>
          Remove
        </button>
      </div>
    );
  if (value.action === "clear")
    return (
      <div className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-danger/30 bg-danger/5 text-[12.5px]">
        <span className="text-danger flex-1">{label} will be removed</span>
        <button className="text-accent text-[12px] hover:underline" onClick={() => onChange({ action: "keep" })}>
          Undo
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Input type={show ? "text" : "password"} value={value.action === "set" ? value.value : ""} onChange={(e) => onChange({ action: "set", value: e.target.value })} placeholder={placeholder} className="pr-8" autoComplete="new-password" />
      <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg" onClick={() => setShow(!show)} aria-label={show ? "Hide" : "Show"}>
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

function emptyInput(): ServerInput {
  return {
    name: "",
    host: "",
    port: 22,
    username: "root",
    authMethod: "password",
    keyPath: null,
    password: { action: "keep" },
    passphrase: { action: "keep" },
    keyData: { action: "keep" },
    group: null,
    tags: [],
    favorite: false,
    color: null,
    notes: null,
    proxy: null,
    proxyPassword: { action: "keep" },
    jumpHostId: null,
    keepaliveSecs: 30,
    connectTimeoutSecs: 15,
    autoReconnect: true,
    useTmux: useSettings.getState().settings.defaultUseTmux,
    startupDir: null,
    startupCommand: null,
  };
}

function fromProfile(p: ServerProfile): ServerInput {
  return {
    name: p.name,
    host: p.host,
    port: p.port,
    username: p.username,
    authMethod: p.authMethod,
    keyPath: p.keyPath,
    password: { action: "keep" },
    passphrase: { action: "keep" },
    keyData: { action: "keep" },
    group: p.group,
    tags: p.tags,
    favorite: p.favorite,
    color: p.color,
    notes: p.notes,
    proxy: p.proxy,
    proxyPassword: { action: "keep" },
    jumpHostId: p.jumpHostId,
    keepaliveSecs: p.keepaliveSecs,
    connectTimeoutSecs: p.connectTimeoutSecs,
    autoReconnect: p.autoReconnect,
    useTmux: p.useTmux,
    startupDir: p.startupDir,
    startupCommand: p.startupCommand,
  };
}

/** Parse "user@host:port" pasted into the host field. */
function smartHost(v: string, cur: ServerInput): Partial<ServerInput> {
  const m = v.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
  if (!m || (!m[1] && !m[3])) return { host: v };
  return { host: m[2], username: m[1] ?? cur.username, port: m[3] ? Number(m[3]) : cur.port };
}

export function ServerEditor() {
  const { open, serverId } = useUi((s) => s.serverEditor);
  const close = useUi((s) => s.closeServerEditor);
  const servers = useServers((s) => s.servers);
  const existing = servers.find((s) => s.id === serverId) ?? null;
  const [input, setInput] = useState<ServerInput>(emptyInput());
  const [section, setSection] = useState<Section>("general");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [keyMode, setKeyMode] = useState<"file" | "paste">("file");
  const [tagsText, setTagsText] = useState("");

  useEffect(() => {
    if (!open) return;
    const i = existing ? fromProfile(existing) : emptyInput();
    setInput(i);
    setTagsText(i.tags.join(", "));
    setSection("general");
    setError(null);
    setKeyMode(existing?.hasKeyData ? "paste" : "file");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  const set = (p: Partial<ServerInput>) => setInput((x) => ({ ...x, ...p }));
  const groups = useMemo(() => [...new Set(servers.map((s) => s.group).filter(Boolean))] as string[], [servers]);
  const jumpCandidates = servers.filter((s) => s.id !== serverId);

  // The display name is optional (falls back to the host), so only host and username gate saving.
  const missing = !input.host.trim() ? "host" : !input.username.trim() ? "username" : null;

  const save = async (connect: boolean) => {
    setSaving(true);
    setError(null);
    const norm = { ...input, ...smartHost(input.host, input) };
    const payload: ServerInput = { ...norm, host: norm.host.trim(), name: input.name.trim() || norm.host.trim(), tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean) };
    try {
      const p = existing ? await api.serverUpdate(existing.id, payload) : await api.serverCreate(payload);
      useServers.getState().upsert(p);
      close();
      useUi.getState().toast({ kind: "success", title: existing ? `Saved ${p.name}` : `Added ${p.name}` });
      if (connect) {
        if (await connectServer(p.id)) void openTool(p.id, "terminal");
      }
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const browseKey = async () => {
    const r = await platform.openDialog({ title: "Choose private key", defaultPath: undefined });
    if (r?.[0]) set({ keyPath: r[0], keyData: { action: "keep" } });
  };

  const NAV: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
    { id: "general", label: "General", icon: <Server size={14} /> },
    { id: "auth", label: "Authentication", icon: <KeyRound size={14} /> },
    { id: "connection", label: "Connection", icon: <Network size={14} /> },
    { id: "advanced", label: "Startup & notes", icon: <Rocket size={14} /> },
  ];

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? `Edit ${existing.name}` : "Add server"}
      subtitle={existing ? `${existing.username}@${existing.host}` : "Connect a VPS over SSH. Passwords and keys are encrypted on this computer."}
      icon={<Server size={18} />}
      width={760}
      closeOnBackdrop={false}
      footer={
        <>
          {missing && <span className="text-[12px] text-fg-3 mr-auto">Enter a {missing} to continue</span>}
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void save(false)} loading={saving} disabled={!!missing} data-testid="server-save">
            Save
          </Button>
          <Button variant="primary" onClick={() => void save(true)} loading={saving} disabled={!!missing} data-testid="server-save-connect">
            Save & connect
          </Button>
        </>
      }
    >
      <div className="flex gap-5 min-h-[380px]">
        <nav className="w-[160px] shrink-0 space-y-0.5 pt-1" aria-label="Server settings sections">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setSection(n.id)} className={cn("w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-[12.5px]", section === n.id ? "bg-accent-soft text-fg font-medium" : "text-fg-3 hover:text-fg hover:bg-bg-3")}>
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 space-y-4 pt-1">
          {error && <ErrorView error={error} compact />}
          {section === "general" && (
            <>
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <Field label="Host or IP address" required hint="Tip: paste user@host:port">
                  <Input autoFocus mono value={input.host} onChange={(e) => {
                      const v = e.target.value;
                      // A paste of "user@host:port" is split right away; typed text is split on blur,
                      // so typing "10.0.0.5:2222" key by key isn't mangled mid-way.
                      const pasted = v.length - input.host.length > 1;
                      set(pasted ? smartHost(v, input) : { host: v });
                    }}
                    onBlur={(e) => set(smartHost(e.target.value, input))}
                    placeholder="203.0.113.10 or vps.example.com"
                    data-testid="server-host"
                  />
                </Field>
                <Field label="Port">
                  <Input mono type="number" min={1} max={65535} value={input.port} onChange={(e) => set({ port: Number(e.target.value) || 22 })} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Username" required>
                  <Input mono value={input.username} onChange={(e) => set({ username: e.target.value })} placeholder="root" data-testid="server-username" />
                </Field>
                <Field label="Display name">
                  <Input value={input.name} onChange={(e) => set({ name: e.target.value })} placeholder={input.host || "Production VPS"} data-testid="server-name" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Group">
                  <Input value={input.group ?? ""} onChange={(e) => set({ group: e.target.value || null })} placeholder="Production" list="server-groups" />
                  <datalist id="server-groups">
                    {groups.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Tags" hint="Comma separated">
                  <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="web, shopify" />
                </Field>
              </div>
              <Field label="Color">
                <div className="flex items-center gap-1.5">
                  {COLORS.map((c) => (
                    <button key={c} onClick={() => set({ color: c })} className={cn("h-6 w-6 rounded-md transition-transform", input.color === c && "ring-2 ring-offset-2 ring-offset-bg-2 ring-fg scale-110")} style={{ background: c }} aria-label={`Color ${c}`} />
                  ))}
                  <button onClick={() => set({ color: null })} className={cn("h-6 px-2 rounded-md text-[11px] border border-line text-fg-3", !input.color && "ring-2 ring-fg")}>
                    Auto
                  </button>
                </div>
              </Field>
              <label className="flex items-center gap-2 text-[13px] text-fg-2">
                <Switch checked={input.favorite} onChange={(v) => set({ favorite: v })} />
                <Star size={13} className={input.favorite ? "text-warn fill-warn" : "text-fg-3"} /> Favorite
              </label>
            </>
          )}

          {section === "auth" && (
            <>
              <Field label="Authentication method">
                <Segmented<AuthMethod>
                  value={input.authMethod}
                  onChange={(v) => set({ authMethod: v })}
                  options={[
                    { value: "password", label: <><Lock size={12} />Password</> },
                    { value: "key", label: <><FileKey2 size={12} />Private key</> },
                    { value: "agent", label: <><ShieldCheck size={12} />SSH agent</> },
                  ]}
                />
              </Field>
              {input.authMethod === "password" && (
                <Field label="Password" hint="Leave empty to be asked each time you connect.">
                  <SecretInput label="Password" has={!!existing?.hasPassword} value={input.password} onChange={(v) => set({ password: v })} placeholder="SSH password" />
                </Field>
              )}
              {input.authMethod === "key" && (
                <>
                  <Segmented value={keyMode} onChange={setKeyMode} options={[{ value: "file", label: "Key file on this PC" }, { value: "paste", label: "Import key into vault" }]} />
                  {keyMode === "file" ? (
                    <Field label="Private key file" hint="OpenSSH format (id_ed25519, id_rsa…). PuTTY .ppk keys must be exported to OpenSSH first.">
                      <div className="flex gap-2">
                        <Input mono value={input.keyPath ?? ""} onChange={(e) => set({ keyPath: e.target.value || null })} placeholder="C:\Users\you\.ssh\id_ed25519" />
                        <Button icon={<FolderOpen size={13} />} onClick={() => void browseKey()}>
                          Browse
                        </Button>
                      </div>
                    </Field>
                  ) : (
                    <Field label="Private key" hint="Stored encrypted in Brainbox's vault — not in plain text.">
                      {existing?.hasKeyData && input.keyData.action === "keep" ? (
                        <SecretInput label="Private key" has value={input.keyData} onChange={(v) => set({ keyData: v })} />
                      ) : (
                        <Textarea mono rows={5} value={input.keyData.action === "set" ? input.keyData.value : ""} onChange={(e) => set({ keyData: { action: "set", value: e.target.value } })} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"} />
                      )}
                    </Field>
                  )}
                  <Field label="Key passphrase" hint="Only if your key is encrypted. Leave empty to be asked when needed.">
                    <SecretInput label="Passphrase" has={!!existing?.hasPassphrase} value={input.passphrase} onChange={(v) => set({ passphrase: v })} placeholder="Passphrase (optional)" />
                  </Field>
                </>
              )}
              {input.authMethod === "agent" && (
                <div className="rounded-lg border border-line bg-bg-1 p-3 text-[12.5px] text-fg-2 space-y-1.5">
                  <p>Brainbox uses keys loaded in your SSH agent — the Windows <b>OpenSSH Authentication Agent</b> service or <b>Pageant</b>.</p>
                  <p className="text-fg-3">Start the agent and add a key with <code className="font-mono text-fg">ssh-add</code>. Your private key never leaves the agent.</p>
                </div>
              )}
            </>
          )}

          {section === "connection" && (
            <>
              <Field label="Jump host (ProxyJump)" hint="Reach this server through another saved server.">
                <Select value={input.jumpHostId ?? ""} onChange={(e) => set({ jumpHostId: e.target.value || null })}>
                  <option value="">None — connect directly</option>
                  {jumpCandidates.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.host})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Proxy">
                <div className="flex gap-2 items-center">
                  <Select
                    value={input.proxy?.kind ?? ""}
                    onChange={(e) => {
                      const k = e.target.value as ProxyKind | "";
                      set({ proxy: k ? { kind: k, host: input.proxy?.host ?? "", port: input.proxy?.port ?? (k === "http" ? 8080 : 1080), username: input.proxy?.username ?? null, hasPassword: !!input.proxy?.hasPassword } : null });
                    }}
                    className="w-36"
                  >
                    <option value="">No proxy</option>
                    <option value="socks5">SOCKS5</option>
                    <option value="http">HTTP CONNECT</option>
                  </Select>
                  {input.proxy && (
                    <>
                      <Input mono value={input.proxy.host} onChange={(e) => set({ proxy: { ...input.proxy!, host: e.target.value } })} placeholder="proxy host" />
                      <Input mono type="number" className="w-24" value={input.proxy.port} onChange={(e) => set({ proxy: { ...input.proxy!, port: Number(e.target.value) } })} />
                    </>
                  )}
                </div>
              </Field>
              {input.proxy && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Proxy username">
                    <Input value={input.proxy.username ?? ""} onChange={(e) => set({ proxy: { ...input.proxy!, username: e.target.value || null } })} placeholder="optional" />
                  </Field>
                  <Field label="Proxy password">
                    <SecretInput label="Proxy password" has={!!existing?.proxy?.hasPassword} value={input.proxyPassword} onChange={(v) => set({ proxyPassword: v })} placeholder="optional" />
                  </Field>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Keepalive interval (seconds)" hint="0 disables keepalives.">
                  <Input type="number" min={0} value={input.keepaliveSecs} onChange={(e) => set({ keepaliveSecs: Math.max(0, Number(e.target.value)) })} />
                </Field>
                <Field label="Connection timeout (seconds)">
                  <Input type="number" min={3} value={input.connectTimeoutSecs} onChange={(e) => set({ connectTimeoutSecs: Math.max(3, Number(e.target.value)) })} />
                </Field>
              </div>
              <label className="flex items-start gap-3 text-[13px]">
                <Switch checked={input.autoReconnect} onChange={(v) => set({ autoReconnect: v })} />
                <span>
                  <span className="text-fg">Reconnect automatically</span>
                  <span className="block text-[12px] text-fg-3">If the connection drops, Brainbox retries with back-off and resumes terminals and tunnels.</span>
                </span>
              </label>
              <label className="flex items-start gap-3 text-[13px]">
                <Switch checked={input.useTmux} onChange={(v) => set({ useTmux: v })} />
                <span>
                  <span className="text-fg">Persistent sessions with tmux</span>
                  <span className="block text-[12px] text-fg-3">Shells keep running on the server even if Brainbox closes or the network drops, and re-attach automatically. Requires tmux on the server.</span>
                </span>
              </label>
            </>
          )}

          {section === "advanced" && (
            <>
              <Field label="Start in directory" hint="New terminals and the file manager open here.">
                <Input mono value={input.startupDir ?? ""} onChange={(e) => set({ startupDir: e.target.value || null })} placeholder="/var/www/app" />
              </Field>
              <Field label="Run after login" hint="Typed into each new shell (e.g. source ~/.venv/bin/activate).">
                <Input mono value={input.startupCommand ?? ""} onChange={(e) => set({ startupCommand: e.target.value || null })} placeholder="optional" />
              </Field>
              <Field label={<span className="flex items-center gap-1.5"><StickyNote size={12} /> Notes</span>}>
                <Textarea rows={5} value={input.notes ?? ""} onChange={(e) => set({ notes: e.target.value || null })} placeholder="Anything worth remembering about this server" />
              </Field>
              <p className="flex items-center gap-1.5 text-fg-3 text-[12px]">
                <Lock size={12} /> Brainbox never stores passwords or keys in plain text.
              </p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
