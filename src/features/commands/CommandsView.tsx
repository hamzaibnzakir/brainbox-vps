import { useMemo, useState } from "react";
import { Edit3, Keyboard, Play, Plus, Terminal, Trash2, Zap, FileOutput, Globe2, Server } from "lucide-react";
import type { CommandAssessment, ExecOutput, Snippet, SnippetInput } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { useSnippets } from "@/stores/data";
import { connState, useServers } from "@/stores/servers";
import { toastError, useUi } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { leaf, useWorkspace, paneLeaves, type Tab, type PaneNode } from "@/stores/workspace";
import { Modal } from "@/components/Modal";
import { openMenu } from "@/components/ContextMenu";
import { Badge, Button, EmptyState, Field, IconButton, Input, Kbd, SearchInput, Select, Textarea, Toolbar } from "@/components/ui";
import { chordFromEvent } from "@/lib/keys";
import { cn } from "@/lib/format";
import { connectServer } from "../servers/actions";
import { getPane, sendToPane } from "../terminal/registry";

export function riskBadge(a: CommandAssessment | null | undefined) {
  if (!a) return null;
  if (a.risk === "dangerous") return <Badge tone="danger">dangerous</Badge>;
  if (a.risk === "mutating") return <Badge tone="warn">changes server</Badge>;
  return <Badge tone="ok">read-only</Badge>;
}

function SnippetEditor({ initial, id, onDone }: { initial: SnippetInput; id: string | null; onDone: (s?: Snippet) => void }) {
  const servers = useServers((s) => s.servers);
  const snippets = useSnippets((s) => s.snippets);
  const [s, setS] = useState<SnippetInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const categories = [...new Set(snippets.map((x) => x.category).filter(Boolean))] as string[];
  const save = async () => {
    try {
      const r = await api.snippetSave(id, s);
      useSnippets.getState().upsert(r);
      onDone(r);
    } catch (e) {
      setErr(toAppError(e).message);
    }
  };
  return (
    <Modal
      open
      onClose={() => onDone()}
      title={id ? "Edit command" : "New command"}
      icon={<Zap size={18} />}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} data-testid="snippet-save">
            Save command
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input autoFocus value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Deploy" />
          </Field>
          <Field label="Category">
            <Input value={s.category ?? ""} onChange={(e) => setS({ ...s, category: e.target.value || null })} placeholder="Deploy, Docker, Git…" list="snippet-cats" />
            <datalist id="snippet-cats">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Command" hint="Multi-line commands run line by line in the terminal.">
          <Textarea mono rows={4} value={s.command} onChange={(e) => setS({ ...s, command: e.target.value })} placeholder="docker compose up -d" />
        </Field>
        <Field label="Description">
          <Input value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value || null })} placeholder="Optional" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Available on">
            <Select value={s.serverId ?? ""} onChange={(e) => setS({ ...s, serverId: e.target.value || null })}>
              <option value="">All servers (global)</option>
              {servers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} only
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keyboard shortcut" hint="Runs in the active server's terminal.">
            <div className="flex gap-1.5">
              <button
                className={cn("h-8 flex-1 rounded-md border px-2 text-left text-[12.5px]", recording ? "border-accent bg-accent-softer text-fg" : "border-line-2 bg-bg-1 text-fg-2")}
                onClick={() => setRecording(true)}
                onKeyDown={(e) => {
                  if (!recording) return;
                  e.preventDefault();
                  if (e.key === "Escape") return setRecording(false);
                  if (e.key === "Backspace") {
                    setS({ ...s, shortcut: null });
                    return setRecording(false);
                  }
                  const c = chordFromEvent(e.nativeEvent);
                  if (c && (e.ctrlKey || e.altKey)) {
                    setS({ ...s, shortcut: c });
                    setRecording(false);
                  }
                }}
                onBlur={() => setRecording(false)}
              >
                {recording ? "Press keys… (Backspace clears)" : s.shortcut ? <Kbd chord={s.shortcut} /> : "Click to record"}
              </button>
            </div>
          </Field>
        </div>
        {err && <div className="text-[12.5px] text-danger">{err}</div>}
      </div>
    </Modal>
  );
}

export function editSnippet(existing: Snippet | null, preset: Partial<SnippetInput> = {}) {
  const initial: SnippetInput = existing
    ? { name: existing.name, description: existing.description, command: existing.command, category: existing.category, serverId: existing.serverId, shortcut: existing.shortcut }
    : { name: "", description: null, command: "", category: null, serverId: null, shortcut: null, ...preset };
  return useUi.getState().custom<Snippet>((close) => <SnippetEditor initial={initial} id={existing?.id ?? null} onDone={close} />);
}

/** Type a command into the server's focused terminal (opening one if needed). */
export async function runInTerminal(serverId: string, command: string) {
  if (connState(serverId) !== "connected" && !(await connectServer(serverId))) return;
  const ws = useWorkspace.getState();
  const active = ws.tabs.find((t) => t.id === ws.activeTabId);
  const term = (active?.kind === "terminal" && active.serverId === serverId ? active : undefined) ?? ws.tabs.find((t) => t.kind === "terminal" && t.serverId === serverId);
  const text = command.replace(/\r?\n/g, "\r") + "\r";
  if (term) {
    ws.activate(term.id);
    const pane = paneLeaves(term.data.layout as PaneNode).find((l) => getPane(l.id)?.status === "open");
    if (pane && sendToPane(pane.id, text)) return;
  }
  // New terminal; type the command once the shell is ready.
  const p = leaf({ kind: "ssh", serverId });
  ws.openTab("terminal", serverId, { layout: p }, { newTab: true });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (getPane(p.id)?.status === "open") {
      await new Promise((r) => setTimeout(r, 350));
      sendToPane(p.id, text);
      return;
    }
  }
}

function OutputDialog({ title, out, onClose }: { title: string; out: ExecOutput; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={title} subtitle={`exit code ${out.exitCode ?? "?"} · ${out.durationMs} ms`} icon={<FileOutput size={18} />} width={760} footer={<Button onClick={onClose}>Close</Button>}>
      <pre className="font-mono text-[12px] bg-[var(--bg-term)] border border-line rounded-md p-3 max-h-[55vh] overflow-auto whitespace-pre-wrap break-all text-fg-2 selectable">
        {out.stdout}
        {out.stderr && <span className="text-warn">{out.stderr}</span>}
        {!out.stdout && !out.stderr && <span className="text-fg-4">(no output)</span>}
      </pre>
    </Modal>
  );
}

/** Run non-interactively and show the captured output (with a risk check). */
export async function runCaptured(serverId: string, s: { name: string; command: string }) {
  if (connState(serverId) !== "connected" && !(await connectServer(serverId))) return;
  const a = await api.commandAssess(s.command);
  let confirmed = a.risk === "mutating" && !useSettings.getState().settings.confirmDangerousCommands;
  if (a.risk !== "read_only" && !confirmed) {
    confirmed = await useUi.getState().confirm({
      title: `Run “${s.name}”?`,
      message: a.risk === "dangerous" ? "This command looks destructive." : "This command changes the server.",
      command: s.command,
      details: a.reasons,
      danger: a.risk === "dangerous",
      confirmLabel: "Run",
    });
    if (!confirmed) return;
  }
  const t = useUi.getState().toast({ kind: "info", title: `Running ${s.name}…`, timeout: 0 });
  try {
    const out = await api.commandRun(serverId, s.command, confirmed);
    useUi.getState().dismissToast(t);
    void useUi.getState().custom((close) => <OutputDialog title={s.name} out={out} onClose={() => close()} />);
  } catch (e) {
    useUi.getState().dismissToast(t);
    toastError(toAppError(e));
  }
}

export function CommandsView({ tab }: { tab: Tab }) {
  const snippets = useSnippets((s) => s.snippets);
  const servers = useServers((s) => s.servers);
  const selected = useWorkspace((s) => s.selectedServerId);
  const serverId = tab.serverId ?? selected;
  const [q, setQ] = useState("");
  const list = useMemo(
    () =>
      snippets
        .filter((s) => (tab.serverId ? !s.serverId || s.serverId === tab.serverId : true))
        .filter((s) => !q || `${s.name} ${s.command} ${s.category ?? ""} ${s.description ?? ""}`.toLowerCase().includes(q.toLowerCase())),
    [snippets, q, tab.serverId],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Snippet[]>();
    for (const s of list) {
      const c = s.category || "General";
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(s);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const del = async (s: Snippet) => {
    if (!(await useUi.getState().confirm({ title: `Delete “${s.name}”?`, danger: true, confirmLabel: "Delete" }))) return;
    await api.snippetDelete(s.id);
    useSnippets.getState().remove(s.id);
  };
  const target = serverId && servers.find((x) => x.id === serverId);
  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar>
        <Zap size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">Command Center</span>
        <SearchInput value={q} onChange={setQ} placeholder="Search commands" className="w-64 ml-2" />
        <div className="flex-1" />
        {target ? <span className="text-[12px] text-fg-3 flex items-center gap-1.5"><Server size={12} /> runs on <span className="text-fg-2">{target.name}</span></span> : <span className="text-[12px] text-warn">Select a server to run commands</span>}
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => void editSnippet(null, tab.serverId ? { serverId: tab.serverId } : {})} data-testid="new-snippet">
          New command
        </Button>
      </Toolbar>
      <div className="flex-1 overflow-auto p-4">
        {!list.length ? (
          <EmptyState icon={<Zap size={20} />} title="No saved commands" body="Save the commands you run often — deploys, restarts, log tails — and run them with one click or a keyboard shortcut." action={<Button variant="primary" icon={<Plus size={13} />} onClick={() => void editSnippet(null)}>New command</Button>} />
        ) : (
          groups.map(([cat, items]) => (
            <section key={cat} className="mb-6">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-3 mb-2">{cat}</h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-2.5">
                {items.map((s) => (
                  <div
                    key={s.id}
                    className="group rounded-lg border border-line bg-bg-2 hover:border-line-2 p-3 flex flex-col gap-2"
                    onContextMenu={(e) =>
                      openMenu(e, [
                        { label: "Run in terminal", icon: <Terminal size={14} />, disabled: !serverId, onClick: () => serverId && void runInTerminal(serverId, s.command) },
                        { label: "Run & show output", icon: <FileOutput size={14} />, disabled: !serverId, onClick: () => serverId && void runCaptured(serverId, s) },
                        { label: "Broadcast to servers…", icon: <Globe2 size={14} />, onClick: () => useWorkspace.getState().openTab("broadcast", null, { command: s.command }) },
                        { type: "separator" },
                        { label: "Edit…", icon: <Edit3 size={14} />, onClick: () => void editSnippet(s) },
                        { label: "Delete", icon: <Trash2 size={14} />, danger: true, onClick: () => void del(s) },
                      ])
                    }
                    data-testid="snippet-card"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-fg truncate">{s.name}</span>
                      {s.serverId ? <Badge tone="accent">{servers.find((x) => x.id === s.serverId)?.name ?? "server"}</Badge> : <Badge>global</Badge>}
                      {s.shortcut && <Kbd chord={s.shortcut} className="ml-auto" />}
                    </div>
                    <pre className="font-mono text-[12px] text-fg-2 bg-[var(--bg-term)] rounded-md px-2.5 py-1.5 border border-line whitespace-pre-wrap break-all line-clamp-3">{s.command}</pre>
                    {s.description && <p className="text-[12px] text-fg-3">{s.description}</p>}
                    <div className="flex items-center gap-1">
                      <Button size="xs" variant="primary" icon={<Play size={11} />} disabled={!serverId} onClick={() => serverId && void runInTerminal(serverId, s.command)}>
                        Run
                      </Button>
                      <Button size="xs" variant="ghost" icon={<FileOutput size={11} />} disabled={!serverId} onClick={() => serverId && void runCaptured(serverId, s)}>
                        Output
                      </Button>
                      <div className="flex-1" />
                      <IconButton label="Edit" size="xs" className="opacity-0 group-hover:opacity-100" onClick={() => void editSnippet(s)}>
                        <Edit3 size={12} />
                      </IconButton>
                      <IconButton label="Delete" size="xs" tone="danger" className="opacity-0 group-hover:opacity-100" onClick={() => void del(s)}>
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
        <div className="mt-2 text-[11.5px] text-fg-4 flex items-center gap-1.5">
          <Keyboard size={12} /> Tip: assign shortcuts like Ctrl+Alt+1 to run commands in the active server's terminal from anywhere.
        </div>
      </div>
    </div>
  );
}
