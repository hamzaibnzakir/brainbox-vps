import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Plug, Radio, Send, XCircle, Copy, Zap } from "lucide-react";
import type { BroadcastResult, CommandAssessment } from "@/types/generated";
import { api, EVENTS, on } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { useServers } from "@/stores/servers";
import { useSnippets } from "@/stores/data";
import { toastError, useUi } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { Avatar, Button, Checkbox, EmptyState, IconButton, Spinner, StatusDot, Textarea } from "@/components/ui";
import { openMenuAt } from "@/components/ContextMenu";
import { cn } from "@/lib/format";
import { connectServer } from "../servers/actions";
import { riskBadge } from "../commands/CommandsView";

export function BroadcastView({ tab }: { tab: Tab }) {
  const servers = useServers((s) => s.servers);
  const statuses = useServers((s) => s.statuses);
  const ws = useWorkspace((s) => s.workspaces.find((w) => w.id === s.currentId));
  const update = useWorkspace((s) => s.updateTab);
  const snippets = useSnippets((s) => s.snippets);
  const [selected, setSelected] = useState<Set<string>>(new Set(tab.data.selected ?? ws?.serverIds ?? []));
  const [command, setCommand] = useState<string>(tab.data.command ?? "");
  const [assessment, setAssessment] = useState<CommandAssessment | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, BroadcastResult>>({});
  const [ranCommand, setRanCommand] = useState("");
  const runningFor = useRef<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => (command.trim() ? void api.commandAssess(command).then(setAssessment) : setAssessment(null)), 200);
    return () => clearTimeout(t);
  }, [command]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void on<BroadcastResult>(EVENTS.broadcast, (r) => {
      if (runningFor.current.has(r.serverId)) setResults((x) => ({ ...x, [r.serverId]: r }));
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  const connected = useMemo(() => servers.filter((s) => statuses[s.id]?.state.state === "connected").map((s) => s.id), [servers, statuses]);
  const toggle = (id: string, v: boolean) => {
    const n = new Set(selected);
    if (v) n.add(id);
    else n.delete(id);
    setSelected(n);
    update(tab.id, { selected: [...n] });
  };

  const run = async () => {
    const ids = [...selected];
    if (!ids.length || !command.trim()) return;
    const a = assessment ?? (await api.commandAssess(command));
    let confirmed = a.risk === "mutating" && !useSettings.getState().settings.confirmDangerousCommands;
    if (a.risk !== "read_only" && !confirmed) {
      const names = ids.map((id) => servers.find((s) => s.id === id)?.name ?? id);
      confirmed = await useUi.getState().confirm({
        title: `Run on ${ids.length} server${ids.length > 1 ? "s" : ""}?`,
        message: <>This command {a.risk === "dangerous" ? <b className="text-danger">looks destructive</b> : "changes server state"} and will run on: {names.join(", ")}.</>,
        command,
        details: a.reasons,
        danger: a.risk === "dangerous",
        requireText: a.risk === "dangerous" ? "run" : undefined,
        confirmLabel: `Run on ${ids.length} server${ids.length > 1 ? "s" : ""}`,
      });
      if (!confirmed) return;
    }
    const offline = ids.filter((id) => statuses[id]?.state.state !== "connected");
    if (offline.length) await Promise.all(offline.map((id) => connectServer(id, { quiet: true })));
    runningFor.current = new Set(ids);
    setResults({});
    setRanCommand(command);
    setRunning(true);
    update(tab.id, { command });
    try {
      const r = await api.broadcastRun(ids, command, confirmed);
      const m: Record<string, BroadcastResult> = {};
      for (const x of r.results) m[x.serverId] = x;
      setResults(m);
      const failed = r.results.filter((x) => x.error || (x.output && x.output.exitCode !== 0)).length;
      useUi.getState().toast({ kind: failed ? "warning" : "success", title: failed ? `Finished with ${failed} failure${failed > 1 ? "s" : ""}` : `Ran on ${r.results.length} servers` });
    } catch (e) {
      toastError(toAppError(e));
    } finally {
      setRunning(false);
    }
  };

  const ids = [...runningFor.current];
  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[280px] shrink-0 border-r border-line bg-bg-1 flex flex-col">
        <div className="p-3 border-b border-line">
          <div className="flex items-center gap-2">
            <Radio size={15} className="text-accent" />
            <span className="text-[13px] font-semibold text-fg">Broadcast</span>
          </div>
          <p className="text-[11.5px] text-fg-3 mt-1">Run the same command on several servers and compare the results.</p>
        </div>
        <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-[11.5px]">
          <button className="text-accent hover:underline" onClick={() => (setSelected(new Set(servers.map((s) => s.id))), update(tab.id, { selected: servers.map((s) => s.id) }))}>
            All
          </button>
          <button className="text-accent hover:underline" onClick={() => (setSelected(new Set(connected)), update(tab.id, { selected: connected }))}>
            Connected
          </button>
          {ws?.serverIds.length ? (
            <button className="text-accent hover:underline" onClick={() => (setSelected(new Set(ws.serverIds)), update(tab.id, { selected: ws.serverIds }))}>
              Workspace
            </button>
          ) : null}
          <button className="text-fg-3 hover:underline ml-auto" onClick={() => (setSelected(new Set()), update(tab.id, { selected: [] }))}>
            None
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {servers.map((s) => {
            const st = statuses[s.id]?.state.state ?? "disconnected";
            return (
              <label key={s.id} className="flex items-center gap-2.5 px-3 h-10 hover:bg-bg-3" data-testid="broadcast-server">
                <Checkbox checked={selected.has(s.id)} onChange={(v) => toggle(s.id, v)} />
                <Avatar name={s.name} color={s.color} size={22} />
                <span className="text-[12.5px] text-fg flex-1 truncate">{s.name}</span>
                <StatusDot state={st} size={7} />
              </label>
            );
          })}
        </div>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-4 border-b border-line bg-bg-2 space-y-2">
          <div className="relative">
            <Textarea
              mono
              rows={3}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="git pull && npm run build"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void run();
                }
              }}
              data-testid="broadcast-command"
            />
          </div>
          <div className="flex items-center gap-2">
            {riskBadge(assessment)}
            {assessment?.reasons.slice(0, 2).map((r) => (
              <span key={r} className="text-[11.5px] text-fg-3 truncate">
                {r}
              </span>
            ))}
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              icon={<Zap size={13} />}
              onClick={(e) =>
                openMenuAt(e.currentTarget, snippets.length ? snippets.map((s) => ({ label: s.name, hint: s.category ?? undefined, onClick: () => setCommand(s.command) })) : [{ type: "header", label: "No saved commands" }])
              }
            >
              Saved commands
            </Button>
            <Button variant="primary" icon={running ? <Spinner size={13} className="text-white" /> : <Send size={13} />} disabled={!command.trim() || !selected.size || running} onClick={() => void run()} data-testid="broadcast-run">
              Run on {selected.size} server{selected.size === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {!ids.length ? (
            <EmptyState icon={<Radio size={20} />} title="Results appear here" body="Each server's output, exit code and duration is shown separately. Ctrl+Enter runs the command." />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(420px,1fr))] gap-3">
              {ids.map((id) => {
                const s = servers.find((x) => x.id === id);
                const r = results[id];
                const ok = r?.output && r.output.exitCode === 0;
                return (
                  <div key={id} className={cn("rounded-lg border bg-bg-2 flex flex-col min-h-[140px] anim-fade", !r ? "border-line" : ok ? "border-ok/30" : "border-danger/30")} data-testid="broadcast-result">
                    <div className="flex items-center gap-2 h-10 px-3 border-b border-line">
                      <Avatar name={s?.name ?? id} color={s?.color} size={20} />
                      <span className="text-[12.5px] font-semibold text-fg truncate">{r?.serverName ?? s?.name}</span>
                      <div className="flex-1" />
                      {!r ? (
                        <Spinner size={13} />
                      ) : r.error ? (
                        <span className="flex items-center gap-1 text-[11.5px] text-danger">
                          <XCircle size={13} /> {r.error.title}
                        </span>
                      ) : (
                        <span className={cn("flex items-center gap-1 text-[11.5px] tabular", ok ? "text-ok" : "text-danger")}>
                          {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} exit {r.output!.exitCode} · {r.output!.durationMs} ms
                        </span>
                      )}
                      {r?.output && (
                        <IconButton label="Copy output" size="xs" onClick={() => void platform.writeClipboard(r.output!.stdout + r.output!.stderr)}>
                          <Copy size={12} />
                        </IconButton>
                      )}
                    </div>
                    <pre className="flex-1 font-mono text-[12px] p-3 bg-[var(--bg-term)] rounded-b-lg overflow-auto max-h-72 whitespace-pre-wrap break-all text-fg-2 selectable">
                      {!r ? (
                        <span className="text-fg-4">Running…</span>
                      ) : r.error ? (
                        <span className="text-danger">
                          {r.error.message}
                          {r.error.code === "not_connected" && (
                            <button className="ml-2 text-accent underline inline-flex items-center gap-1" onClick={() => void connectServer(id)}>
                              <Plug size={11} /> connect
                            </button>
                          )}
                        </span>
                      ) : (
                        <>
                          {r.output!.stdout}
                          {r.output!.stderr && <span className="text-warn">{r.output!.stderr}</span>}
                          {!r.output!.stdout && !r.output!.stderr && <span className="text-fg-4">(no output)</span>}
                        </>
                      )}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
          {ranCommand && <div className="mt-3 text-[11.5px] text-fg-4 font-mono">$ {ranCommand}</div>}
        </div>
      </div>
    </div>
  );
}
