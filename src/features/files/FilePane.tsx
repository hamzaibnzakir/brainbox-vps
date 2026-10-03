import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { platform } from "@/services/platform";
import {
  ArrowLeft, ArrowRight, ArrowUp, Copy, Download, Eye, EyeOff, File, FileCode2, FileImage, FileText, Folder, FolderOpen, FolderPlus, FilePlus, HardDrive, Home, Info, Link2, Pencil, RefreshCw, Scissors, Search, Trash2, Upload, ExternalLink, Archive, FolderInput,
} from "lucide-react";
import type { AppError, DirListing, FileEntry } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { useSettings } from "@/stores/settings";
import { toastError, useUi } from "@/stores/ui";
import { DataTable, type Column } from "@/components/DataTable";
import { openMenu, type MenuItem } from "@/components/ContextMenu";
import { IconButton, Spinner, EmptyState } from "@/components/ui";
import { ErrorView } from "@/components/ErrorView";
import { cn, formatBytes, formatDate, permString } from "@/lib/format";
import { basename, breadcrumbs, dirname, extension, joinPath } from "@/lib/paths";
import { isProbablyText } from "@/lib/languages";

export type Side = "local" | "remote";

export interface FilePaneHandle {
  path: string;
  refresh: () => void;
  selection: () => FileEntry[];
  entries: () => FileEntry[];
  navigate: (p: string) => void;
  focus: () => void;
}

export const DND_TYPE = "application/x-brainbox-files";

function iconFor(e: FileEntry) {
  if (e.kind === "dir" || e.linkIsDir) return <Folder size={15} className="text-accent fill-accent/20" />;
  const ext = extension(e.name);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return <FileImage size={15} className="text-info" />;
  if (["zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "tar"].includes(ext)) return <Archive size={15} className="text-warn" />;
  if (["js", "ts", "tsx", "jsx", "py", "rs", "go", "php", "sh", "json", "yml", "yaml", "toml", "conf", "html", "css", "sql"].includes(ext) || e.name.startsWith(".env")) return <FileCode2 size={15} className="text-ok" />;
  if (["md", "txt", "log", "csv"].includes(ext)) return <FileText size={15} className="text-fg-2" />;
  return <File size={15} className="text-fg-3" />;
}

interface Props {
  side: Side;
  serverId?: string;
  initialPath?: string | null;
  onPathChange?: (p: string) => void;
  onOpenFile?: (e: FileEntry) => void;
  onTransfer?: (entries: FileEntry[], fromPath: string) => void;
  onDropFiles?: (paths: string[], data: { side: Side; serverId?: string; entries: FileEntry[] } | null, targetDir: string) => void;
  onActivate?: () => void;
  active?: boolean;
  otherLabel?: string;
}

export const FilePane = forwardRef<FilePaneHandle, Props>(function FilePane({ side, serverId, initialPath, onPathChange, onOpenFile, onTransfer, onDropFiles, onActivate, active, otherLabel }, ref) {
  const [path, setPath] = useState<string>(initialPath ?? "");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const globalHidden = useSettings((s) => s.settings.showHiddenFiles);
  const [showHidden, setShowHidden] = useState(globalHidden);
  const ui = useUi();
  const rootRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const list = useCallback(
    async (p: string) => {
      const id = ++seq.current;
      setLoading(true);
      try {
        const l = side === "remote" ? await api.sftpList(serverId!, p) : await api.localList(p);
        if (id !== seq.current) return;
        setListing(l);
        setError(null);
        setPath(l.path);
        onPathChange?.(l.path);
        setSearchResults(null);
      } catch (e) {
        if (id === seq.current) setError(toAppError(e));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [side, serverId, onPathChange],
  );

  useEffect(() => {
    (async () => {
      let start = initialPath ?? "";
      if (!start) {
        try {
          start = side === "remote" ? await api.sftpHome(serverId!) : await api.localHome();
        } catch (e) {
          setError(toAppError(e));
          return;
        }
      }
      await list(start);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, side]);

  const navigate = useCallback(
    (p: string, push = true) => {
      if (push && path) {
        setBack((b) => [...b.slice(-50), path]);
        setFwd([]);
      }
      setSelected(new Set());
      setFilter("");
      void list(p);
    },
    [list, path],
  );

  const entries = useMemo(() => {
    const src = searchResults ?? listing?.entries ?? [];
    return src.filter((e) => (showHidden || !e.hidden) && (!filter || e.name.toLowerCase().includes(filter.toLowerCase())));
  }, [listing, searchResults, showHidden, filter]);

  const sel = useCallback(() => entries.filter((e) => selected.has(e.path)), [entries, selected]);

  useImperativeHandle(ref, () => ({
    path,
    refresh: () => void list(path),
    selection: sel,
    entries: () => entries,
    navigate: (p) => navigate(p),
    focus: () => rootRef.current?.querySelector<HTMLElement>("[role=table] [tabindex]")?.focus(),
  }));

  const refresh = () => void list(path);
  const isDir = (e: FileEntry) => e.kind === "dir" || e.linkIsDir;
  const open = (e: FileEntry) => {
    if (isDir(e)) navigate(e.path);
    else if (side === "local") void api.localOpen(e.path).catch((er) => toastError(toAppError(er)));
    else onOpenFile?.(e);
  };

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) ui.toast({ kind: "success", title: okMsg });
    } catch (e) {
      toastError(toAppError(e));
    }
    refresh();
  };

  const newFolder = async () => {
    const r = await ui.prompt({ title: "New folder", label: "Folder name", confirmLabel: "Create", validate: (v) => (v.trim() && !/[\\/]/.test(v) ? null : "Enter a valid name") });
    if (!r) return;
    await run(() => (side === "remote" ? api.sftpMkdir(serverId!, joinPath(path, r.value.trim())) : api.localMkdir(path, r.value.trim())));
  };
  const newFile = async () => {
    const r = await ui.prompt({ title: "New file", label: "File name", confirmLabel: "Create", validate: (v) => (v.trim() && !/[\\/]/.test(v) ? null : "Enter a valid name") });
    if (!r) return;
    const name = r.value.trim();
    await run(() => (side === "remote" ? api.sftpCreateFile(serverId!, joinPath(path, name)) : api.localCreateFile(path, name)));
    if (side === "remote") onOpenFile?.({ name, path: joinPath(path, name), kind: "file", linkIsDir: false, size: 0, modified: null, permissions: null, owner: null, group: null, hidden: false });
  };
  const rename = async (e: FileEntry) => {
    const r = await ui.prompt({ title: `Rename “${e.name}”`, label: "New name", initial: e.name, confirmLabel: "Rename", validate: (v) => (v.trim() && !/[\\/]/.test(v) ? null : "Enter a valid name") });
    if (!r || r.value === e.name) return;
    await run(() => (side === "remote" ? api.sftpRename(serverId!, e.path, joinPath(dirname(e.path), r.value.trim())) : api.localRename(e.path, r.value.trim())));
  };
  const remove = async (items: FileEntry[]) => {
    if (!items.length) return;
    const dirs = items.filter(isDir).length;
    const ok = await ui.confirm({
      title: items.length === 1 ? `Delete “${items[0].name}”?` : `Delete ${items.length} items?`,
      message:
        side === "remote" ? (
          <>This permanently deletes {dirs ? "the folders and everything inside them" : "the files"} on the server. This cannot be undone.</>
        ) : (
          <>The items will be moved to the Recycle Bin.</>
        ),
      details: items.slice(0, 6).map((i) => i.path).concat(items.length > 6 ? [`…and ${items.length - 6} more`] : []),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await run(() => (side === "remote" ? api.sftpDelete(serverId!, items.map((i) => i.path), true) : api.localDelete(items.map((i) => i.path), false, true)), items.length === 1 ? `Deleted ${items[0].name}` : `Deleted ${items.length} items`);
    setSelected(new Set());
  };
  const duplicate = async (e: FileEntry) => {
    const ext = extension(e.name);
    const stem = ext ? e.name.slice(0, -(ext.length + 1)) : e.name;
    const target = joinPath(dirname(e.path), `${stem} copy${ext ? "." + ext : ""}`);
    await run(() => (side === "remote" ? api.sftpCopy(serverId!, e.path, target) : api.localCopy([e.path], dirname(e.path))));
  };
  const moveTo = async (items: FileEntry[]) => {
    const r = await ui.prompt({ title: `Move ${items.length === 1 ? `“${items[0].name}”` : `${items.length} items`}`, label: "Destination folder", initial: path, confirmLabel: "Move" });
    if (!r || r.value === path) return;
    await run(() => (side === "remote" ? api.sftpMove(serverId!, items.map((i) => i.path), r.value.trim()) : api.localMove(items.map((i) => i.path), r.value.trim())));
  };
  const properties = (e: FileEntry) => {
    void import("./PropertiesDialog").then(({ showProperties }) => showProperties(e, side, serverId, refresh));
  };
  const doSearch = async () => {
    const r = await ui.prompt({ title: `Search in ${basename(path) || path}`, label: "File name contains", confirmLabel: "Search" });
    if (!r?.value.trim()) return;
    setSearching(true);
    try {
      setSearchResults(side === "remote" ? await api.sftpSearch(serverId!, path, r.value.trim()) : await api.localSearch(path, r.value.trim()));
    } catch (e) {
      toastError(toAppError(e));
    } finally {
      setSearching(false);
    }
  };

  const rowMenu = (e: FileEntry): MenuItem[] => {
    const s = selected.has(e.path) ? sel() : [e];
    const multi = s.length > 1;
    return [
      { type: "header", label: multi ? `${s.length} items` : e.name },
      ...(isDir(e) && !multi ? [{ label: "Open", icon: <FolderOpen size={14} />, shortcut: "Enter", onClick: () => open(e) } as MenuItem] : []),
      ...(!isDir(e) && !multi && side === "remote" ? [{ label: isProbablyText(e.name, e.size) ? "Edit" : "Open as text", icon: <FileCode2 size={14} />, shortcut: "Enter", onClick: () => onOpenFile?.(e) } as MenuItem] : []),
      ...(!isDir(e) && !multi && side === "local" ? [{ label: "Open", icon: <ExternalLink size={14} />, onClick: () => void api.localOpen(e.path) } as MenuItem, { label: "Show in Explorer", icon: <FolderOpen size={14} />, onClick: () => void api.localReveal(e.path) } as MenuItem] : []),
      ...(onTransfer
        ? [{ label: side === "remote" ? `Download to ${otherLabel ?? "local"}` : `Upload to ${otherLabel ?? "server"}`, icon: side === "remote" ? <Download size={14} /> : <Upload size={14} />, shortcut: "F5", onClick: () => onTransfer(s, path) } as MenuItem]
        : []),
      { type: "separator" },
      ...(!multi ? [{ label: "Rename", icon: <Pencil size={14} />, shortcut: "F2", onClick: () => void rename(e) } as MenuItem, { label: "Duplicate", icon: <Copy size={14} />, onClick: () => void duplicate(e) } as MenuItem] : []),
      { label: "Move to…", icon: <FolderInput size={14} />, onClick: () => void moveTo(s) },
      { label: "Copy path", icon: <Link2 size={14} />, onClick: () => void platform.writeClipboard(s.map((x) => x.path).join("\n")) },
      ...(!multi ? [{ label: "Properties", icon: <Info size={14} />, shortcut: "Alt+Enter", onClick: () => properties(e) } as MenuItem] : []),
      { type: "separator" },
      { label: "Delete", icon: <Trash2 size={14} />, shortcut: "Del", danger: true, onClick: () => void remove(s) },
    ];
  };

  const bgMenu = (): MenuItem[] => [
    { label: "New folder", icon: <FolderPlus size={14} />, shortcut: "F7", onClick: () => void newFolder() },
    { label: "New file", icon: <FilePlus size={14} />, onClick: () => void newFile() },
    { type: "separator" },
    { label: "Refresh", icon: <RefreshCw size={14} />, shortcut: "Ctrl+R", onClick: refresh },
    { label: showHidden ? "Hide hidden files" : "Show hidden files", icon: showHidden ? <EyeOff size={14} /> : <Eye size={14} />, onClick: () => setShowHidden(!showHidden) },
    ...(side === "local" && path ? [{ label: "Open in Explorer", icon: <ExternalLink size={14} />, onClick: () => void api.localOpen(path) } as MenuItem] : []),
  ];

  const onRowClick = (e: FileEntry, ev: React.MouseEvent) => {
    onActivate?.();
    if (ev.ctrlKey || ev.metaKey) {
      const n = new Set(selected);
      if (n.has(e.path)) n.delete(e.path);
      else n.add(e.path);
      setSelected(n);
      setAnchor(e.path);
    } else if (ev.shiftKey && anchor) {
      const i1 = entries.findIndex((x) => x.path === anchor);
      const i2 = entries.findIndex((x) => x.path === e.path);
      const [a, b] = [Math.min(i1, i2), Math.max(i1, i2)];
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.path)));
    } else {
      setSelected(new Set([e.path]));
      setAnchor(e.path);
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    const s = sel();
    const cur = entries.findIndex((x) => x.path === anchor);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = entries[Math.max(0, Math.min(entries.length - 1, cur + (ev.key === "ArrowDown" ? 1 : -1)))];
      if (n) {
        setSelected(ev.shiftKey ? new Set([...selected, n.path]) : new Set([n.path]));
        setAnchor(n.path);
      }
    } else if (ev.key === "Enter" && ev.altKey && s[0]) properties(s[0]);
    else if (ev.key === "Enter" && s[0]) open(s[0]);
    else if (ev.key === "Backspace" && listing?.parent != null) navigate(listing.parent);
    else if (ev.key === "Delete" && s.length) void remove(s);
    else if (ev.key === "F2" && s[0]) void rename(s[0]);
    else if (ev.key === "F7") (ev.preventDefault(), void newFolder());
    else if (ev.key === "F5" && s.length && onTransfer) (ev.preventDefault(), onTransfer(s, path));
    else if (ev.key.toLowerCase() === "r" && ev.ctrlKey) (ev.preventDefault(), refresh());
    else if (ev.key.toLowerCase() === "a" && ev.ctrlKey) (ev.preventDefault(), setSelected(new Set(entries.map((x) => x.path))));
    else if (ev.key === "Escape") setSelected(new Set());
  };

  const columns: Column<FileEntry>[] = [
    {
      key: "name",
      header: "Name",
      width: "minmax(180px,1fr)",
      sort: (a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
      render: (e) => (
        <span
          className={cn("flex items-center gap-2 min-w-0", e.hidden && "opacity-60")}
          draggable
          onDragStart={(ev) => {
            const items = selected.has(e.path) ? sel() : [e];
            ev.dataTransfer.setData(DND_TYPE, JSON.stringify({ side, serverId, entries: items }));
            ev.dataTransfer.effectAllowed = "copy";
          }}
        >
          {iconFor(e)}
          <span className="truncate text-fg">{e.name}</span>
          {e.kind === "symlink" && <Link2 size={11} className="text-fg-4 shrink-0" />}
          {searchResults && <span className="truncate text-fg-4 text-[11px]">{dirname(e.path)}</span>}
        </span>
      ),
    },
    { key: "size", header: "Size", width: 90, align: "right", sort: (a, b) => a.size - b.size, render: (e) => (isDir(e) ? <span className="text-fg-4">—</span> : formatBytes(e.size)) },
    { key: "modified", header: "Modified", width: 140, sort: (a, b) => (a.modified ?? 0) - (b.modified ?? 0), render: (e) => <span className="text-fg-3">{formatDate(e.modified)}</span> },
    ...(side === "remote"
      ? [
          { key: "perm", header: "Permissions", width: 96, render: (e: FileEntry) => <span className="font-mono text-[11.5px] text-fg-3">{permString(e.permissions, isDir(e))}</span> },
          { key: "owner", header: "Owner", width: 80, sort: (a: FileEntry, b: FileEntry) => (a.owner ?? "").localeCompare(b.owner ?? ""), render: (e: FileEntry) => <span className="text-fg-3">{e.owner ?? "—"}</span> },
        ]
      : []),
  ];

  const crumbs = breadcrumbs(path);
  return (
    <div
      ref={rootRef}
      className={cn("flex flex-col min-w-0 min-h-0 flex-1 relative", active && "ring-1 ring-inset ring-accent/20")}
      onKeyDown={onKeyDown}
      onMouseDown={onActivate}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPE) || e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        setDragOver(false);
        const raw = e.dataTransfer.getData(DND_TYPE);
        if (raw) {
          e.preventDefault();
          const data = JSON.parse(raw);
          if (data.side === side && data.serverId === serverId) return; // same pane
          onDropFiles?.([], data, path);
        }
      }}
      data-pane-side={side}
      data-testid={`file-pane-${side}`}
    >
      <div className="flex items-center gap-1 h-10 px-2 border-b border-line bg-bg-2 shrink-0">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-3 px-1 flex items-center gap-1.5">
          {side === "local" ? <HardDrive size={12} /> : <Folder size={12} />}
          {side === "local" ? "This PC" : "Server"}
        </span>
        <IconButton label="Back" size="xs" disabled={!back.length} onClick={() => { const b = back[back.length - 1]; setBack(back.slice(0, -1)); setFwd([path, ...fwd]); navigate(b, false); }}>
          <ArrowLeft size={13} />
        </IconButton>
        <IconButton label="Forward" size="xs" disabled={!fwd.length} onClick={() => { const f = fwd[0]; setFwd(fwd.slice(1)); setBack([...back, path]); navigate(f, false); }}>
          <ArrowRight size={13} />
        </IconButton>
        <IconButton label="Up (Backspace)" size="xs" disabled={listing?.parent == null} onClick={() => listing?.parent != null && navigate(listing.parent)}>
          <ArrowUp size={13} />
        </IconButton>
        <IconButton label="Home" size="xs" onClick={async () => navigate(side === "remote" ? await api.sftpHome(serverId!) : await api.localHome())}>
          <Home size={13} />
        </IconButton>
        <div className="flex-1 min-w-0 mx-1">
          {editingPath ? (
            <input
              autoFocus
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditingPath(false);
                  navigate(pathDraft.trim());
                }
                if (e.key === "Escape") setEditingPath(false);
              }}
              className="w-full h-6 rounded bg-bg-1 border border-accent px-2 font-mono text-[12px] text-fg"
            />
          ) : (
            <div className="flex items-center h-6 rounded hover:bg-bg-3 px-1 overflow-hidden cursor-text" onClick={() => { setPathDraft(path); setEditingPath(true); }} title="Click to type a path">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center shrink-0 last:shrink">
                  {i > 0 && c.name !== "/" && crumbs[i - 1].name !== "/" && <span className="text-fg-4 px-0.5">/</span>}
                  <button
                    className={cn("text-[12px] px-1 rounded hover:bg-bg-4 truncate max-w-[180px]", i === crumbs.length - 1 ? "text-fg" : "text-fg-3")}
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(c.path);
                    }}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-6 w-24 rounded bg-bg-1 border border-line px-2 text-[12px] text-fg placeholder:text-fg-4 focus:border-accent focus:w-36 transition-all" />
        <IconButton label="Search subfolders" size="xs" onClick={() => void doSearch()}>
          {searching ? <Spinner size={12} /> : <Search size={13} />}
        </IconButton>
        <IconButton label={showHidden ? "Hide hidden files" : "Show hidden files"} size="xs" active={showHidden} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </IconButton>
        <IconButton label="New folder (F7)" size="xs" onClick={() => void newFolder()}>
          <FolderPlus size={13} />
        </IconButton>
        <IconButton label="Refresh (Ctrl+R)" size="xs" onClick={refresh}>
          <RefreshCw size={13} className={loading ? "anim-spin" : ""} />
        </IconButton>
      </div>
      {searchResults && (
        <div className="flex items-center gap-2 px-3 h-7 bg-accent-softer border-b border-line text-[12px] text-fg-2">
          <Search size={12} /> {searchResults.length} results
          <button className="ml-auto text-accent hover:underline" onClick={() => setSearchResults(null)}>
            Clear search
          </button>
        </div>
      )}
      {error && !listing ? (
        <div className="p-4">
          <ErrorView error={error} compact actions={<button className="text-[12px] text-accent hover:underline" onClick={refresh}>Retry</button>} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col" onContextMenu={(e) => { if (!(e.target as HTMLElement).closest("[role=row]")) openMenu(e, bgMenu()); }}>
          {error && <div className="px-3 py-1.5 text-[12px] text-danger border-b border-line bg-danger/5">{error.message}</div>}
          <DataTable
            rows={entries}
            columns={columns}
            rowKey={(e) => e.path}
            rowHeight={28}
            selected={selected}
            initialSort={{ key: "name" }}
            onRowClick={onRowClick}
            onRowDoubleClick={open}
            onRowContextMenu={(e, ev) => {
              if (!selected.has(e.path)) setSelected(new Set([e.path]));
              openMenu(ev, rowMenu(e));
            }}
            empty={loading ? <div className="p-6 flex justify-center"><Spinner /></div> : <EmptyState title={filter ? "No matches" : "Empty folder"} body={side === "remote" ? "Drop files here to upload." : undefined} />}
          />
        </div>
      )}
      <div className="h-6 px-3 flex items-center gap-3 border-t border-line text-[11px] text-fg-3 bg-bg-1 shrink-0">
        <span>{entries.length} {entries.length === 1 ? "item" : "items"}</span>
        {selected.size > 0 && (
          <span className="text-fg-2">
            {selected.size} selected · {formatBytes(sel().reduce((a, e) => a + (isDir(e) ? 0 : e.size), 0))}
          </span>
        )}
        <span className="flex-1" />
        {selected.size > 0 && onTransfer && (
          <button className="flex items-center gap-1 text-accent hover:underline" onClick={() => onTransfer(sel(), path)}>
            {side === "remote" ? <Download size={11} /> : <Upload size={11} />}
            {side === "remote" ? "Download" : "Upload"} (F5)
          </button>
        )}
        {selected.size > 0 && (
          <button className="flex items-center gap-1 hover:text-fg-2" onClick={() => void moveTo(sel())}>
            <Scissors size={11} /> Move
          </button>
        )}
      </div>
      {dragOver && (
        <div className="absolute inset-0 z-20 pointer-events-none border-2 border-dashed border-accent rounded-md bg-accent-softer flex items-center justify-center anim-fade">
          <div className="rounded-lg bg-bg-2 border border-line-2 px-4 py-2 text-[13px] text-fg shadow-pop flex items-center gap-2">
            {side === "remote" ? <Upload size={15} className="text-accent" /> : <Download size={15} className="text-accent" />}
            {side === "remote" ? "Drop to upload here" : "Drop to download here"}
          </div>
        </div>
      )}
    </div>
  );
});
