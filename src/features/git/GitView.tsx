import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, CloudDownload, FolderGit2, GitBranch, GitCommitHorizontal, RefreshCw, Search, SquareTerminal, Check, FileDiff } from "lucide-react";
import type { GitBranch as Branch, GitCommit, GitFileChange } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { toastError, useUi } from "@/stores/ui";
import { leaf, useWorkspace, type Tab } from "@/stores/workspace";
import { useAsync } from "@/hooks/useAsync";
import { Badge, Button, EmptyState, IconButton, Input, Segmented, Spinner } from "@/components/ui";
import { ErrorPanel, ErrorView } from "@/components/ErrorView";
import { cn, relativeTime } from "@/lib/format";
import { ConnectGate } from "../servers/ConnectGate";

function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <EmptyState icon={<FileDiff size={18} />} title="No changes" body="Nothing to show for this selection." />;
  return (
    <pre className="font-mono text-[12px] leading-[18px] selectable p-0 m-0">
      {text.split("\n").map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre",
            l.startsWith("+") && !l.startsWith("+++") && "bg-ok/10 text-ok",
            l.startsWith("-") && !l.startsWith("---") && "bg-danger/10 text-danger",
            l.startsWith("@@") && "text-info bg-info/5",
            (l.startsWith("diff ") || l.startsWith("commit ") || l.startsWith("index ")) && "text-fg-3 font-semibold",
            !/^[+\-@]|^diff |^commit |^index /.test(l) && "text-fg-2",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function statusLetter(f: GitFileChange) {
  if (f.untracked) return <Badge tone="info">new</Badge>;
  const s = f.staged || f.unstaged;
  const tone = s === "M" ? "warn" : s === "A" ? "ok" : s === "D" ? "danger" : s === "R" ? "accent" : "neutral";
  return <Badge tone={tone}>{s}</Badge>;
}

function Repo({ serverId, repo }: { serverId: string; repo: string }) {
  const status = useAsync(() => api.gitStatus(serverId, repo), [serverId, repo]);
  const branches = useAsync(() => api.gitBranches(serverId, repo), [serverId, repo]);
  const log = useAsync(() => api.gitLog(serverId, repo, 100), [serverId, repo]);
  const [pane, setPane] = useState<"changes" | "history" | "branches">("changes");
  const [diffKey, setDiffKey] = useState<{ kind: "file"; path: string; staged: boolean } | { kind: "commit"; hash: string } | { kind: "all" }>({ kind: "all" });
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const diff = useAsync(
    () => (diffKey.kind === "commit" ? api.gitShow(serverId, repo, diffKey.hash) : diffKey.kind === "file" ? api.gitDiff(serverId, repo, diffKey.path, diffKey.staged) : api.gitDiff(serverId, repo, null, false)),
    [serverId, repo, JSON.stringify(diffKey)],
  );
  const reload = () => {
    void status.reload();
    void branches.reload();
    void log.reload();
    void diff.reload();
  };

  const runAction = async (action: "fetch" | "pull" | "push") => {
    if (action !== "fetch") {
      const ok = await useUi.getState().confirm({
        title: action === "pull" ? "Pull latest changes?" : "Push your commits?",
        message: action === "pull" ? "Runs a fast-forward-only pull: it never creates merge commits or overwrites local changes." : `Pushes ${status.data?.ahead ?? 0} commit(s) to ${status.data?.upstream ?? "the upstream branch"}.`,
        command: `git -C ${repo} ${action === "pull" ? "pull --ff-only" : "push"}`,
        confirmLabel: action === "pull" ? "Pull" : "Push",
      });
      if (!ok) return;
    }
    setBusy(action);
    try {
      const out = await api.gitAction(serverId, repo, action, true);
      setOutput(out || "Done.");
      useUi.getState().toast({ kind: "success", title: `git ${action} finished` });
    } catch (e) {
      toastError(toAppError(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const checkout = async (b: Branch) => {
    if (b.isCurrent) return;
    const ok = await useUi.getState().confirm({ title: `Switch to ${b.name}?`, message: b.isRemote ? "A local tracking branch will be created." : "Uncommitted changes that conflict will stop the switch.", command: `git checkout ${b.isRemote ? "--track " : ""}${b.name}`, confirmLabel: "Switch branch" });
    if (!ok) return;
    setBusy("checkout");
    try {
      await api.gitCheckout(serverId, repo, b.name, true);
      useUi.getState().toast({ kind: "success", title: `Switched to ${b.name}` });
    } catch (e) {
      toastError(toAppError(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  const terminal = () => useWorkspace.getState().openTab("terminal", serverId, { layout: leaf({ kind: "ssh", serverId, cwd: repo }) }, { newTab: true });

  if (status.error && !status.data) return <ErrorPanel error={status.error} onRetry={reload} />;
  const st = status.data;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-11 px-3 border-b border-line bg-bg-2 shrink-0">
        <GitBranch size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">{st?.branch ?? (status.loading ? "…" : "detached HEAD")}</span>
        {st?.upstream && <span className="text-[12px] text-fg-3">→ {st.upstream}</span>}
        {!!st?.ahead && (
          <Badge tone="accent">
            <ArrowUpFromLine size={10} />
            {st.ahead}
          </Badge>
        )}
        {!!st?.behind && (
          <Badge tone="warn">
            <ArrowDownToLine size={10} />
            {st.behind}
          </Badge>
        )}
        <span className="text-[12px] text-fg-3 font-mono truncate ml-2">{repo}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<CloudDownload size={13} />} loading={busy === "fetch"} onClick={() => void runAction("fetch")}>
          Fetch
        </Button>
        <Button size="sm" variant="ghost" icon={<ArrowDownToLine size={13} />} loading={busy === "pull"} onClick={() => void runAction("pull")}>
          Pull
        </Button>
        <Button size="sm" variant="ghost" icon={<ArrowUpFromLine size={13} />} loading={busy === "push"} onClick={() => void runAction("push")} disabled={!st?.ahead}>
          Push
        </Button>
        <div className="w-px h-5 bg-line" />
        <IconButton label="Open terminal in repository" onClick={terminal}>
          <SquareTerminal size={14} />
        </IconButton>
        <IconButton label="Refresh" onClick={reload}>
          <RefreshCw size={14} className={status.loading ? "anim-spin" : ""} />
        </IconButton>
      </div>
      {output && (
        <div className="relative border-b border-line bg-bg-1">
          <pre className="font-mono text-[11.5px] text-fg-2 px-3 py-2 max-h-32 overflow-auto selectable">{output}</pre>
          <button className="absolute top-1 right-2 text-[11px] text-fg-3 hover:text-fg" onClick={() => setOutput(null)}>
            dismiss
          </button>
        </div>
      )}
      <div className="flex-1 flex min-h-0">
        <div className="w-[340px] shrink-0 border-r border-line flex flex-col min-h-0 bg-bg-1">
          <div className="p-2 border-b border-line">
            <Segmented
              value={pane}
              onChange={setPane}
              options={[
                { value: "changes", label: <>Changes {st && <span className="text-fg-4">{st.files.length}</span>}</> },
                { value: "history", label: "History" },
                { value: "branches", label: "Branches" },
              ]}
            />
          </div>
          <div className="flex-1 overflow-auto">
            {pane === "changes" &&
              (st?.files.length ? (
                <>
                  <button onClick={() => setDiffKey({ kind: "all" })} className={cn("w-full text-left px-3 h-8 text-[12.5px] flex items-center gap-2 hover:bg-bg-3", diffKey.kind === "all" && "bg-accent-soft")}>
                    <FileDiff size={13} className="text-fg-3" /> All unstaged changes
                  </button>
                  {st.files.map((f) => (
                    <button key={f.path} onClick={() => setDiffKey({ kind: "file", path: f.path, staged: !!f.staged && !f.unstaged })} className={cn("w-full text-left px-3 h-8 text-[12.5px] flex items-center gap-2 hover:bg-bg-3", diffKey.kind === "file" && diffKey.path === f.path && "bg-accent-soft")}>
                      {statusLetter(f)}
                      <span className="truncate font-mono text-[12px] text-fg">{f.path}</span>
                      {f.staged && !f.untracked && <span className="ml-auto text-[10px] text-ok">staged</span>}
                    </button>
                  ))}
                </>
              ) : status.loading ? (
                <div className="p-4"><Spinner /></div>
              ) : (
                <EmptyState icon={<Check size={18} />} title="Working tree clean" />
              ))}
            {pane === "history" &&
              (log.data ?? []).map((c: GitCommit) => (
                <button key={c.hash} onClick={() => setDiffKey({ kind: "commit", hash: c.hash })} className={cn("w-full text-left px-3 py-2 border-b border-line/50 hover:bg-bg-3", diffKey.kind === "commit" && diffKey.hash === c.hash && "bg-accent-soft")}>
                  <div className="text-[12.5px] text-fg truncate">{c.subject}</div>
                  <div className="text-[11px] text-fg-3 flex items-center gap-2 mt-0.5">
                    <GitCommitHorizontal size={11} />
                    <span className="font-mono">{c.hash.slice(0, 7)}</span>
                    <span className="truncate">{c.author}</span>
                    <span className="ml-auto shrink-0">{relativeTime(c.timestamp)}</span>
                  </div>
                </button>
              ))}
            {pane === "branches" &&
              (branches.data ?? []).map((b) => (
                <button key={b.name} onClick={() => void checkout(b)} disabled={busy === "checkout"} className={cn("w-full text-left px-3 h-9 flex items-center gap-2 text-[12.5px] hover:bg-bg-3", b.isCurrent && "bg-accent-soft")} title={b.isCurrent ? "Current branch" : `Switch to ${b.name}`}>
                  <GitBranch size={13} className={b.isCurrent ? "text-accent" : b.isRemote ? "text-fg-4" : "text-fg-3"} />
                  <span className={cn("truncate", b.isRemote ? "text-fg-3" : "text-fg")}>{b.name}</span>
                  {b.isCurrent && <Badge tone="accent">current</Badge>}
                  <span className="ml-auto font-mono text-[11px] text-fg-4">{b.commit}</span>
                </button>
              ))}
          </div>
        </div>
        <div className="flex-1 min-w-0 overflow-auto bg-[var(--bg-term)]">{diff.loading && !diff.data ? <div className="p-4"><Spinner /></div> : diff.error ? <div className="p-4"><ErrorView error={diff.error} compact /></div> : <DiffView text={diff.data ?? ""} />}</div>
      </div>
    </div>
  );
}

function Git({ tab, serverId }: { tab: Tab; serverId: string }) {
  const update = useWorkspace((s) => s.updateTab);
  const repo: string | undefined = tab.data.repo;
  const found = useAsync(() => api.gitDiscover(serverId), [serverId]);
  const [manual, setManual] = useState("");
  const [q, setQ] = useState("");
  const repos = useMemo(() => (found.data ?? []).filter((r) => r.toLowerCase().includes(q.toLowerCase())), [found.data, q]);
  useEffect(() => {
    if (!repo && found.data?.length === 1) update(tab.id, { repo: found.data[0] });
  }, [found.data, repo, tab.id, update]);

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[240px] shrink-0 border-r border-line bg-bg-1 flex flex-col">
        <div className="p-3 border-b border-line space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-3">Repositories</div>
          <Input leading={<Search size={12} />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="h-7 text-[12px]" />
        </div>
        <div className="flex-1 overflow-auto py-1">
          {found.loading ? (
            <div className="p-3 flex items-center gap-2 text-[12px] text-fg-3">
              <Spinner size={12} /> Scanning for repositories…
            </div>
          ) : (
            repos.map((r) => (
              <button key={r} onClick={() => update(tab.id, { repo: r })} className={cn("w-full text-left px-3 py-1.5 hover:bg-bg-3", repo === r && "bg-accent-soft")}>
                <div className="flex items-center gap-2 text-[12.5px] text-fg">
                  <FolderGit2 size={13} className="text-accent shrink-0" />
                  <span className="truncate">{r.split("/").pop()}</span>
                </div>
                <div className="text-[10.5px] text-fg-4 font-mono truncate pl-5">{r}</div>
              </button>
            ))
          )}
          {!found.loading && !repos.length && <div className="p-3 text-[12px] text-fg-3">No repositories found in common locations.</div>}
        </div>
        <form
          className="p-2 border-t border-line flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) update(tab.id, { repo: manual.trim() });
          }}
        >
          <Input mono value={manual} onChange={(e) => setManual(e.target.value)} placeholder="/path/to/repo" className="h-7 text-[11.5px]" />
          <Button size="sm" type="submit">
            Open
          </Button>
        </form>
      </div>
      <div className="flex-1 min-w-0">{repo ? <Repo key={repo} serverId={serverId} repo={repo} /> : <EmptyState icon={<FolderGit2 size={20} />} title="Choose a repository" body="Brainbox scans your home folder, /var/www, /srv and /opt. Every action here is also a normal git command you can run in the terminal." className="h-full" />}</div>
    </div>
  );
}

export function GitView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="use Git tools">
      <Git tab={tab} serverId={tab.serverId!} />
    </ConnectGate>
  );
}
