import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Download, Eraser, FileText, Pause, Play, Radio, RefreshCw, ShieldCheck, WrapText, Regex, Filter } from "lucide-react";
import type { AppError, LogSource, StreamEvent } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { toastError, useUi } from "@/stores/ui";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { useAsync } from "@/hooks/useAsync";
import { Badge, Button, IconButton, Input, Select, Spinner } from "@/components/ui";
import { ErrorView } from "@/components/ErrorView";
import { cn, formatBytes } from "@/lib/format";
import { ConnectGate } from "../servers/ConnectGate";

const MAX_LINES = 50_000;

type Level = "error" | "warn" | "debug" | "info";
export function lineLevel(line: string): Level {
  if (/\b(ERROR|ERR|FATAL|CRIT(ICAL)?|EMERG|ALERT|PANIC|Traceback|Exception)\b|\b(error|failed|fatal)\b/.test(line)) return "error";
  if (/\b(WARN(ING)?|warn(ing)?)\b/.test(line)) return "warn";
  if (/\b(DEBUG|TRACE)\b/.test(line)) return "debug";
  return "info";
}
const LEVEL_CLASS: Record<Level, string> = { error: "text-danger", warn: "text-warn", debug: "text-fg-4", info: "text-fg-2" };
function levelClass(line: string): string {
  return LEVEL_CLASS[lineLevel(line)];
}
/** Minimum severity shown: "all", "warn" (warnings + errors) or "error". */
type LevelFilter = "all" | "warn" | "error";
function passesLevel(line: string, f: LevelFilter): boolean {
  if (f === "all") return true;
  const l = lineLevel(line);
  return f === "error" ? l === "error" : l === "error" || l === "warn";
}

function highlight(line: string, re: RegExp | null) {
  if (!re) return line;
  const parts: React.ReactNode[] = [];
  let last = 0;
  line.replace(re, (m, ...args) => {
    const idx = args[args.length - 2] as number;
    if (idx > last) parts.push(line.slice(last, idx));
    parts.push(
      <mark key={idx} className="bg-accent/40 text-fg rounded-[2px]">
        {m}
      </mark>,
    );
    last = idx + m.length;
    return m;
  });
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function sourceLabel(s: LogSource) {
  switch (s.kind) {
    case "system":
      return "System journal";
    case "service":
      return s.unit;
    case "docker":
      return `Container ${s.container}`;
    case "file":
      return s.path;
  }
}

function Logs({ tab, serverId }: { tab: Tab; serverId: string }) {
  const update = useWorkspace((s) => s.updateTab);
  const source: LogSource = tab.data.source ?? { kind: "system" };
  const [kind, setKind] = useState<LogSource["kind"]>(source.kind);
  const [target, setTarget] = useState(source.kind === "service" ? source.unit : source.kind === "docker" ? source.container : source.kind === "file" ? source.path : "");
  const [linesN, setLinesN] = useState<number>(tab.data.lines ?? 500);
  const [follow, setFollow] = useState(true);
  const [sudo, setSudo] = useState(!!tab.data.sudo);
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"streaming" | "ended" | "error" | "starting">("starting");
  const [error, setError] = useState<AppError | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const pending = useRef<string[]>([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const streamId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const services = useAsync(() => api.servicesList(serverId).then((l) => l.map((s) => s.name)), [serverId], kind === "service");
  const containers = useAsync(() => api.dockerContainers(serverId).then((l) => l.map((c) => c.name)), [serverId], kind === "docker");
  const files = useAsync(() => api.logsDiscover(serverId), [serverId], kind === "file");

  const start = useCallback(
    async (src: LogSource) => {
      if (streamId.current) void api.logsStop(streamId.current);
      streamId.current = null;
      setLines([]);
      pending.current = [];
      setError(null);
      setStatus("starting");
      let buf: string[] = [];
      let raf = 0;
      const flush = () => {
        raf = 0;
        if (pausedRef.current) {
          pending.current.push(...buf);
          if (pending.current.length > MAX_LINES) pending.current = pending.current.slice(-MAX_LINES);
        } else {
          const add = buf;
          setLines((l) => {
            const n = l.length + add.length > MAX_LINES ? [...l, ...add].slice(-MAX_LINES) : [...l, ...add];
            return n;
          });
        }
        buf = [];
      };
      try {
        const id = await api.logsStart({ serverId, source: src, lines: linesN, follow, sudo }, (ev: StreamEvent) => {
          if (ev.type === "lines") {
            buf.push(...ev.lines);
            if (!raf) raf = requestAnimationFrame(flush);
          } else if (ev.type === "end") setStatus("ended");
          else if (ev.type === "error") {
            setError(ev.error);
            setStatus("error");
          }
        });
        streamId.current = id;
        setStatus("streaming");
      } catch (e) {
        setError(toAppError(e));
        setStatus("error");
      }
    },
    [serverId, linesN, follow, sudo],
  );

  const currentSource = (): LogSource | null => {
    if (kind === "system") return { kind: "system" };
    if (!target.trim()) return null;
    if (kind === "service") return { kind: "service", unit: target.trim() };
    if (kind === "docker") return { kind: "docker", container: target.trim() };
    return { kind: "file", path: target.trim() };
  };

  const apply = () => {
    const src = currentSource();
    if (!src) return;
    update(tab.id, { source: src, lines: linesN, sudo });
    void start(src);
  };

  useEffect(() => {
    const src = currentSource();
    if (src) void start(src);
    return () => {
      if (streamId.current) void api.logsStop(streamId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const re = useMemo(() => {
    if (!query) return null;
    try {
      return new RegExp(useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch {
      return null;
    }
  }, [query, useRegex]);

  const shown = useMemo(() => {
    let out = levelFilter === "all" ? lines : lines.filter((l) => passesLevel(l, levelFilter));
    if (onlyMatches && re) out = out.filter((l) => ((re.lastIndex = 0), re.test(l)));
    return out;
  }, [lines, onlyMatches, re, levelFilter]);
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => 19, overscan: 30 });
  useEffect(() => {
    if (atBottom && !paused && shown.length) v.scrollToIndex(shown.length - 1, { align: "end" });
  }, [shown.length, atBottom, paused, v]);

  const resume = () => {
    setPaused(false);
    const p = pending.current;
    pending.current = [];
    if (p.length) setLines((l) => [...l, ...p].slice(-MAX_LINES));
  };

  const exportLogs = async () => {
    const src = currentSource();
    if (!src) return;
    const name = (sourceLabel(src).split("/").pop() ?? "logs").replace(/[^\w.-]+/g, "_");
    const dest = await platform.saveDialog({ title: "Save logs", defaultPath: `${name}-${new Date().toISOString().slice(0, 10)}.log` });
    if (!dest) return;
    try {
      if (src.kind === "file") {
        await api.transferStart({ serverId, direction: "download", localPath: dest, remotePath: src.path, overwrite: true });
        useUi.getState().set({ bottomOpen: true, bottomTab: "transfers" });
      } else {
        const n = await api.logsExport(serverId, src, sudo, dest);
        useUi.getState().toast({ kind: "success", title: "Logs saved", body: `${formatBytes(n)} written to ${dest}` });
      }
    } catch (e) {
      toastError(toAppError(e));
    }
  };

  const matchCount = useMemo(() => (re ? lines.reduce((a, l) => ((re.lastIndex = 0), a + (re.test(l) ? 1 : 0)), 0) : 0), [lines, re]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 h-11 px-3 border-b border-line bg-bg-2 shrink-0 flex-wrap">
        <Select value={kind} onChange={(e) => { setKind(e.target.value as LogSource["kind"]); setTarget(""); }} className="w-36">
          <option value="system">System journal</option>
          <option value="service">Service</option>
          <option value="docker">Docker container</option>
          <option value="file">Log file</option>
        </Select>
        {kind === "service" && (
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-56">
            <option value="">Choose a service…</option>
            {(services.data ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {kind === "docker" && (
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-56">
            <option value="">Choose a container…</option>
            {(containers.data ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
        {kind === "file" && (
          <>
            <Input mono value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/var/log/nginx/error.log" className="w-72" list={`logfiles-${tab.id}`} onKeyDown={(e) => e.key === "Enter" && apply()} />
            <datalist id={`logfiles-${tab.id}`}>
              {(files.data ?? []).map((f) => (
                <option key={f.path} value={f.path}>
                  {formatBytes(f.size)}
                </option>
              ))}
            </datalist>
          </>
        )}
        <Select value={String(linesN)} onChange={(e) => setLinesN(Number(e.target.value))} className="w-28" title="History lines">
          {[100, 500, 1000, 5000, 20000].map((n) => (
            <option key={n} value={n}>
              last {n.toLocaleString()}
            </option>
          ))}
        </Select>
        <Button size="sm" variant={follow ? "subtle" : "ghost"} icon={<Radio size={13} />} onClick={() => setFollow(!follow)} title="Live tail">
          Live
        </Button>
        <Button size="sm" variant={sudo ? "subtle" : "ghost"} icon={<ShieldCheck size={13} />} onClick={() => setSudo(!sudo)} title="Read with sudo (system logs often require it)">
          sudo
        </Button>
        <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} onClick={apply} disabled={kind !== "system" && !target.trim()} data-testid="logs-apply">
          {status === "streaming" ? "Restart" : "Show logs"}
        </Button>
      </div>
      <div className="flex items-center gap-2 h-9 px-3 border-b border-line bg-bg-1 shrink-0">
        <div className="relative">
          <Filter size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search / filter" className="h-6 w-56 rounded bg-bg-0 border border-line pl-6 pr-2 text-[12px] text-fg placeholder:text-fg-4 focus:border-accent" />
        </div>
        <IconButton label="Regular expression" size="xs" active={useRegex} onClick={() => setUseRegex(!useRegex)}>
          <Regex size={13} />
        </IconButton>
        <Button size="xs" variant={onlyMatches ? "subtle" : "ghost"} onClick={() => setOnlyMatches(!onlyMatches)} disabled={!query}>
          Only matches
        </Button>
        {query && <span className="text-[11.5px] text-fg-3 tabular">{matchCount.toLocaleString()} matches</span>}
        <Select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as LevelFilter)} className="h-6 text-[11.5px] py-0" aria-label="Severity" data-testid="logs-level">
          <option value="all">All levels</option>
          <option value="warn">Warnings &amp; errors</option>
          <option value="error">Errors only</option>
        </Select>
        <div className="flex-1" />
        <span className="text-[11.5px] text-fg-3 tabular">{lines.length.toLocaleString()} lines</span>
        {status === "streaming" && follow && !paused && (
          <Badge tone="ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok anim-pulse" /> live
          </Badge>
        )}
        {paused && <Badge tone="warn">paused · {pending.current.length} new</Badge>}
        {status === "ended" && <Badge>ended</Badge>}
        <IconButton label={paused ? "Resume" : "Pause"} size="xs" onClick={() => (paused ? resume() : setPaused(true))}>
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </IconButton>
        <IconButton label="Wrap lines" size="xs" active={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={13} />
        </IconButton>
        <IconButton label="Clear view" size="xs" onClick={() => setLines([])}>
          <Eraser size={13} />
        </IconButton>
        <IconButton label="Download logs" size="xs" onClick={() => void exportLogs()}>
          <Download size={13} />
        </IconButton>
      </div>
      {error && (
        <div className="p-3 border-b border-line">
          <ErrorView error={error} compact />
        </div>
      )}
      <div className="relative flex-1 min-h-0 bg-[var(--bg-term)]">
        <div
          ref={scroller}
          className="absolute inset-0 overflow-auto font-mono text-[12px] leading-[19px] selectable"
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          data-testid="log-lines"
        >
          {status === "starting" && !lines.length ? (
            <div className="flex items-center justify-center h-full">
              <Spinner />
            </div>
          ) : !lines.length ? (
            <div className="flex flex-col items-center justify-center h-full text-fg-3 gap-2 font-sans">
              <FileText size={20} />
              <span className="text-[12.5px]">{status === "ended" ? "No log lines." : "Waiting for log lines…"}</span>
            </div>
          ) : (
            <div style={{ height: v.getTotalSize(), position: "relative", minWidth: wrap ? undefined : "max-content" }}>
              {v.getVirtualItems().map((vi) => {
                const line = shown[vi.index];
                return (
                  <div key={vi.key} data-index={vi.index} ref={wrap ? v.measureElement : undefined} className={cn("absolute left-0 right-0 px-3 hover:bg-bg-3/60", levelClass(line), wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")} style={{ transform: `translateY(${vi.start}px)` }}>
                    {highlight(line, re)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!atBottom && lines.length > 0 && (
          <button className="absolute bottom-3 right-5 z-10 flex items-center gap-1.5 rounded-full bg-accent text-white text-[12px] px-3 h-7 shadow-pop anim-pop" onClick={() => (setAtBottom(true), v.scrollToIndex(shown.length - 1, { align: "end" }))}>
            <ArrowDownToLine size={13} /> Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}

export function LogsView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="view logs">
      <Logs key={JSON.stringify(tab.data.source ?? {})} tab={tab} serverId={tab.serverId!} />
    </ConnectGate>
  );
}
