import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, CaseSensitive, ClipboardPaste, Columns2, Copy, Eraser, Maximize2, Minimize2, Plug, RefreshCw, Rows2, Search, TextSelect, WifiOff, X, Zap } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { useServers } from "@/stores/servers";
import { useSnippets } from "@/stores/data";
import { useWorkspace, paneLeaves, removePane, splitPane, updatePaneSizes, updatePaneSpec, onTabClosed, type PaneNode, type PaneSpec, type Tab } from "@/stores/workspace";
import { attachPane, copySelection, disposePane, fitPane, getPane, pasteInto, restart, sendToPane, type PaneRuntime } from "./registry";
import { SplitView } from "@/components/Split";
import { openMenu, openMenuAt, type MenuItem } from "@/components/ContextMenu";
import { Button, IconButton, Spinner } from "@/components/ui";
import { ErrorView } from "@/components/ErrorView";
import { cn } from "@/lib/format";
import { connectServer } from "../servers/actions";
import { platform } from "@/services/platform";

// Dispose terminal sessions when their tab is closed by the user.
onTabClosed((t) => {
  if ((t.kind === "terminal" || t.kind === "local-terminal") && t.data.layout) {
    for (const l of paneLeaves(t.data.layout as PaneNode)) disposePane(l.id);
  }
});

function usePaneRuntime(paneId: string): PaneRuntime | undefined {
  const sub = useCallback(
    (cb: () => void) => {
      const p = getPane(paneId);
      if (!p) return () => {};
      p.listeners.add(cb);
      return () => p.listeners.delete(cb);
    },
    [paneId],
  );
  // Re-render on status changes.
  useSyncExternalStore(sub, () => {
    const p = getPane(paneId);
    return p ? `${p.status}:${p.error?.title ?? ""}` : "none";
  });
  return getPane(paneId);
}

function SearchBar({ p, onClose }: { p: PaneRuntime; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cs, setCs] = useState(false);
  const opts = { caseSensitive: cs, decorations: { matchOverviewRuler: "#7c5cff", activeMatchColorOverviewRuler: "#ffffff", matchBackground: "#7c5cff55", activeMatchBackground: "#7c5cffcc" } };
  const next = () => q && p.search.findNext(q, opts);
  const prev = () => q && p.search.findPrevious(q, opts);
  return (
    <div className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-line-2 bg-bg-2/95 backdrop-blur shadow-pop p-1 anim-pop" onMouseDown={(e) => e.stopPropagation()}>
      <Search size={13} className="text-fg-3 ml-1.5" />
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          if (e.target.value) p.search.findNext(e.target.value, { ...opts, incremental: true });
          else p.search.clearDecorations();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.shiftKey ? prev() : next());
          if (e.key === "Escape") onClose();
        }}
        placeholder="Find in terminal"
        className="h-6 w-48 bg-transparent text-[12.5px] text-fg placeholder:text-fg-4"
      />
      <IconButton label="Match case" size="xs" active={cs} onClick={() => setCs(!cs)}>
        <CaseSensitive size={13} />
      </IconButton>
      <IconButton label="Previous (Shift+Enter)" size="xs" onClick={prev}>
        <ArrowUp size={13} />
      </IconButton>
      <IconButton label="Next (Enter)" size="xs" onClick={next}>
        <ArrowDown size={13} />
      </IconButton>
      <IconButton
        label="Close (Esc)"
        size="xs"
        onClick={() => {
          p.search.clearDecorations();
          onClose();
        }}
      >
        <X size={13} />
      </IconButton>
    </div>
  );
}

const PaneView = memo(function PaneView({ paneId, spec, tabId, focused, onFocus, single }: { paneId: string; spec: PaneSpec; tabId: string; focused: boolean; onFocus: () => void; single: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState(false);
  const p = usePaneRuntime(paneId);
  const rightClickPaste = useSettings((s) => s.settings.rightClickPaste);
  const server = useServers((s) => (spec.kind === "ssh" ? s.servers.find((x) => x.id === spec.serverId) : undefined));
  const serverState = useServers((s) => (spec.kind === "ssh" ? s.statuses[spec.serverId]?.state : undefined));

  useEffect(() => {
    if (!ref.current) return;
    const rt = attachPane(paneId, spec, ref.current, (name) => {
      const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
      if (tab?.data.layout) useWorkspace.getState().updateTab(tabId, { layout: updatePaneSpec(tab.data.layout, paneId, { tmuxSession: name } as Partial<PaneSpec>) });
    });
    const ro = new ResizeObserver(() => requestAnimationFrame(() => fitPane(paneId)));
    ro.observe(ref.current);
    const onSearch = () => setSearching(true);
    rt.host.addEventListener("bbx-search", onSearch);
    return () => {
      ro.disconnect();
      rt.host.removeEventListener("bbx-search", onSearch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  useEffect(() => {
    if (focused) getPane(paneId)?.term.focus();
  }, [focused, paneId]);

  const menu = (): MenuItem[] => {
    const rt = getPane(paneId)!;
    return [
      { label: "Copy", icon: <Copy size={14} />, shortcut: "Ctrl+Shift+C", disabled: !rt.term.hasSelection(), onClick: () => copySelection(rt) },
      { label: "Paste", icon: <ClipboardPaste size={14} />, shortcut: "Ctrl+V", onClick: () => void pasteInto(rt) },
      { label: "Select all", icon: <TextSelect size={14} />, onClick: () => rt.term.selectAll() },
      { type: "separator" },
      { label: "Find…", icon: <Search size={14} />, shortcut: "Ctrl+Alt+F", onClick: () => setSearching(true) },
      { label: "Clear", icon: <Eraser size={14} />, onClick: () => rt.term.clear() },
      { type: "separator" },
      { label: "Split right", icon: <Columns2 size={14} />, shortcut: "Ctrl+Shift+D", onClick: () => window.dispatchEvent(new CustomEvent("bbx-split", { detail: { tabId, paneId, dir: "row" } })) },
      { label: "Split down", icon: <Rows2 size={14} />, shortcut: "Ctrl+Shift+E", onClick: () => window.dispatchEvent(new CustomEvent("bbx-split", { detail: { tabId, paneId, dir: "column" } })) },
      { label: "Restart session", icon: <RefreshCw size={14} />, onClick: () => void restart(rt) },
      ...(!single ? ([{ type: "separator" }, { label: "Close pane", icon: <X size={14} />, shortcut: "Ctrl+Shift+X", danger: true, onClick: () => window.dispatchEvent(new CustomEvent("bbx-close-pane", { detail: { tabId, paneId } })) }] as MenuItem[]) : []),
    ];
  };

  const status = p?.status ?? "idle";
  const waitingState = serverState?.state;
  return (
    <div
      className={cn("relative flex-1 min-w-0 min-h-0 bg-[var(--bg-term)]", !single && "border-[1.5px]", !single && (focused ? "border-accent/50" : "border-transparent"))}
      onMouseDown={onFocus}
      onContextMenu={(e) => {
        const rt = getPane(paneId);
        if (!rt) return;
        e.preventDefault();
        if (rightClickPaste && !e.shiftKey) {
          if (rt.term.hasSelection()) {
            copySelection(rt);
            rt.term.clearSelection();
          } else void pasteInto(rt);
        } else openMenu(e, menu());
      }}
      data-testid="terminal-pane"
    >
      <div ref={ref} className="absolute inset-0" />
      {searching && p && <SearchBar p={p} onClose={() => (setSearching(false), p.term.focus())} />}
      {status === "suspended" && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full border border-warn/30 bg-bg-2/95 px-3 py-1 text-[12px] text-warn shadow-pop anim-pop">
          <WifiOff size={13} />
          Connection lost — reconnecting…
          <Spinner size={12} className="text-warn" />
        </div>
      )}
      {(status === "waiting" || status === "opening") && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-term)]/80 anim-fade">
          <div className="flex flex-col items-center gap-3 text-center">
            {status === "opening" || waitingState === "connecting" || waitingState === "reconnecting" ? (
              <>
                <Spinner size={20} className="text-accent" />
                <div className="text-[13px] text-fg-2">{status === "opening" ? "Starting shell…" : `Connecting to ${server?.name ?? "server"}…`}</div>
              </>
            ) : waitingState === "failed" ? (
              <div className="max-w-[460px] px-4">
                <ErrorView error={(serverState as { error: import("@/types/generated").AppError }).error} actions={<Button size="sm" variant="primary" icon={<RefreshCw size={13} />} onClick={() => spec.kind === "ssh" && void connectServer(spec.serverId)}>Retry</Button>} />
              </div>
            ) : (
              <>
                <div className="h-11 w-11 rounded-xl bg-bg-3 border border-line flex items-center justify-center text-fg-3">
                  <Plug size={18} />
                </div>
                <div className="text-[13px] text-fg-2">{server?.name ?? "Server"} is not connected</div>
                <Button size="sm" variant="primary" onClick={() => spec.kind === "ssh" && void connectServer(spec.serverId)} data-testid="pane-connect">
                  Connect
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {status === "error" && p?.error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-term)]/90 p-6 anim-fade">
          <ErrorView error={p.error} className="max-w-[520px]" actions={<Button size="sm" variant="primary" onClick={() => void restart(p)}>Try again</Button>} />
        </div>
      )}
    </div>
  );
});

function LayoutView({ node, tab, focusedId, setFocused, single }: { node: PaneNode; tab: Tab; focusedId: string | null; setFocused: (id: string) => void; single: boolean }) {
  const update = useWorkspace((s) => s.updateTab);
  if (node.type === "leaf") return <PaneView paneId={node.id} spec={node.spec} tabId={tab.id} focused={focusedId === node.id} onFocus={() => setFocused(node.id)} single={single} />;
  return (
    <SplitView
      dir={node.dir}
      sizes={node.sizes}
      onSizes={(sizes, done) => {
        const cur = useWorkspace.getState().tabs.find((t) => t.id === tab.id);
        if (cur) update(tab.id, { layout: updatePaneSizes(cur.data.layout, node.id, sizes) });
        if (done) requestAnimationFrame(() => paneLeaves(node).forEach((l) => fitPane(l.id)));
      }}
    >
      {node.children.map((c) => (
        <LayoutView key={c.id} node={c} tab={tab} focusedId={focusedId} setFocused={setFocused} single={single} />
      ))}
    </SplitView>
  );
}

export function TerminalTab({ tab, active }: { tab: Tab; active: boolean }) {
  const layout = tab.data.layout as PaneNode | undefined;
  const leaves = layout ? paneLeaves(layout) : [];
  const [focused, setFocused] = useState<string | null>(leaves[0]?.id ?? null);
  const [zoom, setZoom] = useState(false);
  const [syncInput, setSyncInput] = useState(false);
  const update = useWorkspace((s) => s.updateTab);
  const snippets = useSnippets((s) => s.snippets);
  const serverId = tab.serverId;

  const doSplit = useCallback(
    (paneId: string, dir: "row" | "column") => {
      const cur = useWorkspace.getState().tabs.find((t) => t.id === tab.id);
      if (!cur?.data.layout) return;
      const base = paneLeaves(cur.data.layout).find((l) => l.id === paneId)?.spec;
      if (!base) return;
      const spec: PaneSpec = base.kind === "ssh" ? { kind: "ssh", serverId: base.serverId } : { kind: "local", shellId: base.shellId ?? null };
      const r = splitPane(cur.data.layout, paneId, dir, spec);
      update(tab.id, { layout: r.root });
      setFocused(r.newId);
    },
    [tab.id, update],
  );

  const closePane = useCallback(
    (paneId: string) => {
      const cur = useWorkspace.getState().tabs.find((t) => t.id === tab.id);
      if (!cur?.data.layout) return;
      const next = removePane(cur.data.layout, paneId);
      disposePane(paneId);
      if (!next) void useWorkspace.getState().closeTab(tab.id, true);
      else {
        update(tab.id, { layout: next });
        setFocused(paneLeaves(next)[0]?.id ?? null);
      }
    },
    [tab.id, update],
  );

  useEffect(() => {
    const onSplit = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.tabId === tab.id) doSplit(d.paneId, d.dir);
    };
    const onClose = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.tabId === tab.id) closePane(d.paneId);
    };
    window.addEventListener("bbx-split", onSplit);
    window.addEventListener("bbx-close-pane", onClose);
    return () => {
      window.removeEventListener("bbx-split", onSplit);
      window.removeEventListener("bbx-close-pane", onClose);
    };
  }, [tab.id, doSplit, closePane]);

  // Keyboard shortcuts scoped to the active terminal tab.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const f = focused ?? leaves[0]?.id;
      if (!f) return;
      if (e.ctrlKey && e.shiftKey && e.code === "KeyD") (e.preventDefault(), doSplit(f, "row"));
      else if (e.ctrlKey && e.shiftKey && e.code === "KeyE") (e.preventDefault(), doSplit(f, "column"));
      else if (e.ctrlKey && e.shiftKey && e.code === "KeyX" && leaves.length > 1) (e.preventDefault(), closePane(f));
      else if (e.ctrlKey && e.altKey && e.code === "KeyF") (e.preventDefault(), getPane(f)?.host.dispatchEvent(new Event("bbx-search")));
      else if (e.code === "F11") {
        e.preventDefault();
        setZoom((z) => {
          void platform.setFullscreen(!z);
          return !z;
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, focused, leaves, doSplit, closePane]);

  // Refit when the tab becomes visible.
  useEffect(() => {
    if (active) requestAnimationFrame(() => leaves.forEach((l) => fitPane(l.id)));
  }, [active, zoom, leaves]);

  // Sync input: mirror keystrokes from the focused pane to all panes.
  useEffect(() => {
    if (!syncInput || leaves.length < 2) return;
    const subs = leaves.map((l) => {
      const p = getPane(l.id);
      return p?.term.onData((d) => {
        if (l.id !== focused) return;
        for (const o of leaves) if (o.id !== l.id) sendToPane(o.id, d);
      });
    });
    return () => subs.forEach((s) => s?.dispose());
  }, [syncInput, leaves, focused]);

  if (!layout) return null;
  const runSnippet = (el: HTMLElement) => {
    const list = snippets.filter((s) => !s.serverId || s.serverId === serverId);
    openMenuAt(
      el,
      list.length
        ? [
            { type: "header", label: "Insert saved command" },
            ...list.map((s) => ({
              label: s.name,
              icon: <Zap size={14} />,
              hint: s.category ?? undefined,
              onClick: () => {
                const f = focused ?? leaves[0].id;
                sendToPane(f, s.command + "\r");
              },
            })),
          ]
        : [{ type: "header", label: "No saved commands yet" }],
    );
  };

  return (
    <div className={cn("flex flex-col h-full min-h-0", zoom && "fixed inset-0 z-[90] bg-[var(--bg-term)]")}>
      <div className="flex items-center gap-1 h-8 px-2 border-b border-line bg-bg-1 shrink-0">
        <span className="text-[11.5px] text-fg-3 px-1 truncate">
          {leaves.length > 1 ? `${leaves.length} panes` : getPane(leaves[0].id)?.tmuxSession ? `tmux · ${getPane(leaves[0].id)?.tmuxSession}` : "Shell"}
        </span>
        <div className="flex-1" />
        <IconButton label="Insert saved command" size="xs" onClick={(e) => runSnippet(e.currentTarget)}>
          <Zap size={13} />
        </IconButton>
        <IconButton label="Find (Ctrl+Alt+F)" size="xs" onClick={() => focused && getPane(focused)?.host.dispatchEvent(new Event("bbx-search"))}>
          <Search size={13} />
        </IconButton>
        <IconButton label="Clear" size="xs" onClick={() => focused && getPane(focused)?.term.clear()}>
          <Eraser size={13} />
        </IconButton>
        {leaves.length > 1 && (
          <IconButton label="Type in all panes at once" size="xs" active={syncInput} onClick={() => setSyncInput(!syncInput)}>
            <span className="text-[10px] font-bold">ALL</span>
          </IconButton>
        )}
        <div className="w-px h-4 bg-line mx-0.5" />
        <IconButton label="Split right (Ctrl+Shift+D)" size="xs" onClick={() => doSplit(focused ?? leaves[0].id, "row")}>
          <Columns2 size={13} />
        </IconButton>
        <IconButton label="Split down (Ctrl+Shift+E)" size="xs" onClick={() => doSplit(focused ?? leaves[0].id, "column")}>
          <Rows2 size={13} />
        </IconButton>
        <IconButton label={zoom ? "Exit fullscreen (F11)" : "Fullscreen (F11)"} size="xs" onClick={() => setZoom((z) => (void platform.setFullscreen(!z), !z))}>
          {zoom ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </IconButton>
      </div>
      <div className="flex-1 min-h-0 flex p-0">
        <LayoutView node={layout} tab={tab} focusedId={focused} setFocused={setFocused} single={leaves.length === 1} />
      </div>
    </div>
  );
}

