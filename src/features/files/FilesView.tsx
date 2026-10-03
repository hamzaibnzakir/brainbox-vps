import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ChevronLeft, ChevronRight, Download, Upload } from "lucide-react";
import type { FileEntry, TransferRequest } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { useServers, useConnState } from "@/stores/servers";
import { toastError, useUi } from "@/stores/ui";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { FilePane, type FilePaneHandle, type Side } from "./FilePane";
import { Resizer } from "@/components/Split";
import { Button, IconButton } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { basename, joinPath, windowsSafeName } from "@/lib/paths";
import { ConnectGate } from "../servers/ConnectGate";

type Conflict = "replace" | "skip" | "cancel";

async function askConflicts(names: string[], where: string): Promise<Conflict> {
  return (
    (await useUi.getState().custom<Conflict>((close) => (
      <Modal
        open
        onClose={() => close("cancel")}
        title={names.length === 1 ? `“${names[0]}” already exists` : `${names.length} items already exist`}
        subtitle={`in ${where}`}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => close("cancel")}>
              Cancel
            </Button>
            <Button onClick={() => close("skip")}>Skip existing</Button>
            <Button variant="primary" data-primary onClick={() => close("replace")}>
              Replace
            </Button>
          </>
        }
      >
        <ul className="text-[12.5px] text-fg-2 space-y-0.5 max-h-40 overflow-auto font-mono">
          {names.slice(0, 20).map((n) => (
            <li key={n}>• {n}</li>
          ))}
          {names.length > 20 && <li>… and {names.length - 20} more</li>}
        </ul>
      </Modal>
    ))) ?? "cancel"
  );
}

/** Start transfers with overwrite confirmation; returns the number started. */
export async function startTransfers(serverId: string, direction: "upload" | "download", items: Array<{ local: string; remote: string; name: string }>, existing: Set<string>, whereLabel: string) {
  const clashing = items.filter((i) => existing.has(i.name));
  let replace = false;
  let list = items;
  if (clashing.length) {
    const r = await askConflicts(clashing.map((c) => c.name), whereLabel);
    if (r === "cancel") return 0;
    if (r === "skip") list = items.filter((i) => !existing.has(i.name));
    else replace = true;
  }
  if (!list.length) return 0;
  const reqs: TransferRequest[] = list.map((i) => ({ serverId, direction, localPath: i.local, remotePath: i.remote, overwrite: replace }));
  try {
    await api.transferStartMany(reqs);
    useUi.getState().set({ bottomOpen: true, bottomTab: "transfers" });
  } catch (e) {
    toastError(toAppError(e));
  }
  return list.length;
}

export function FilesView({ tab }: { tab: Tab }) {
  const serverId = tab.serverId!;
  const state = useConnState(serverId);
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const update = useWorkspace((s) => s.updateTab);
  const local = useRef<FilePaneHandle>(null);
  const remote = useRef<FilePaneHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState<number>(tab.data.split ?? 45);
  const [activeSide, setActiveSide] = useState<Side>("remote");
  const [osDrag, setOsDrag] = useState<Side | null>(null);
  const showLocal = tab.data.showLocal ?? true;

  const upload = useCallback(
    async (entries: Array<{ path: string; name: string }>, remoteDir?: string) => {
      const dir = remoteDir ?? remote.current?.path;
      if (!dir) return;
      const existing = new Set((remote.current?.entries() ?? []).map((e) => e.name));
      const n = await startTransfers(serverId, "upload", entries.map((e) => ({ local: e.path, remote: joinPath(dir, e.name), name: e.name })), dir === remote.current?.path ? existing : new Set(), dir);
      if (n) setTimeout(() => remote.current?.refresh(), 1500);
    },
    [serverId],
  );

  const download = useCallback(
    async (entries: FileEntry[], localDir?: string) => {
      const dir = localDir ?? local.current?.path;
      if (!dir) {
        const picked = await platform.openDialog({ directory: true, title: "Download to folder" });
        if (!picked?.[0]) return;
        return download(entries, picked[0]);
      }
      const existing = new Set((local.current?.entries() ?? []).map((e) => e.name));
      const items = entries.map((e) => {
        const safe = windowsSafeName(e.name);
        return { local: joinPath(dir, safe), remote: e.path, name: safe };
      });
      const n = await startTransfers(serverId, "download", items, dir === local.current?.path ? existing : new Set(), dir);
      if (n) setTimeout(() => local.current?.refresh(), 1500);
    },
    [serverId],
  );

  // Native OS drag & drop (files from Windows Explorer).
  useEffect(() => {
    let un: (() => void) | undefined;
    void platform
      .onFileDrop((e) => {
        const tabActive = useWorkspace.getState().activeTabId === tab.id;
        if (!tabActive) return;
        const el = document.elementFromPoint(e.x, e.y)?.closest<HTMLElement>("[data-pane-side]");
        const side = (el?.dataset.paneSide as Side | undefined) ?? null;
        if (e.type === "over" || e.type === "enter") setOsDrag(side);
        else if (e.type === "leave") setOsDrag(null);
        else if (e.type === "drop") {
          setOsDrag(null);
          if (!e.paths.length) return;
          if (side === "remote" || !side) void upload(e.paths.map((p) => ({ path: p, name: basename(p) })));
          else if (side === "local" && local.current?.path) {
            void api.localCopy(e.paths, local.current.path).then(() => local.current?.refresh()).catch((er) => toastError(toAppError(er)));
          }
        }
      })
      .then((u) => (un = u));
    return () => un?.();
  }, [tab.id, upload]);

  const onPick = async () => {
    const files = await platform.openDialog({ multiple: true, title: "Choose files to upload" });
    if (files?.length) void upload(files.map((p) => ({ path: p, name: basename(p) })));
  };
  const onPickFolder = async () => {
    const dirs = await platform.openDialog({ directory: true, title: "Choose a folder to upload" });
    if (dirs?.length) void upload(dirs.map((p) => ({ path: p, name: basename(p) })));
  };

  const openFile = (e: FileEntry) => void useWorkspace.getState().openTab("editor", serverId, { path: e.path });

  return (
    <ConnectGate serverId={serverId} what="browse files">
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-2 h-9 px-3 border-b border-line bg-bg-1 shrink-0">
          <IconButton label={showLocal ? "Hide local pane" : "Show local pane"} size="xs" onClick={() => update(tab.id, { showLocal: !showLocal })}>
            {showLocal ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </IconButton>
          <span className="text-[12px] text-fg-3">Drag files between panes or from Windows Explorer. F5 transfers the selection.</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" icon={<Upload size={13} />} onClick={() => void onPick()} disabled={state !== "connected"}>
            Upload files
          </Button>
          <Button size="sm" variant="ghost" icon={<Upload size={13} />} onClick={() => void onPickFolder()} disabled={state !== "connected"}>
            Upload folder
          </Button>
        </div>
        <div ref={container} className="flex-1 flex min-h-0">
          {showLocal && (
            <>
              <div className="flex min-w-0 min-h-0" style={{ width: `${split}%` }}>
                <FilePane
                  ref={local}
                  side="local"
                  initialPath={tab.data.localPath ?? null}
                  onPathChange={(p) => update(tab.id, { localPath: p })}
                  onTransfer={(entries) => void upload(entries.map((e) => ({ path: e.path, name: e.name })))}
                  onDropFiles={(_p, data) => data?.side === "remote" && void download(data.entries)}
                  onActivate={() => setActiveSide("local")}
                  active={activeSide === "local"}
                  otherLabel={server?.name}
                />
              </div>
              <div className="flex flex-col items-center justify-center gap-1 px-0.5 bg-bg-1 border-x border-line">
                <IconButton label="Upload selection →" size="xs" onClick={() => { const s = local.current?.selection() ?? []; if (s.length) void upload(s.map((e) => ({ path: e.path, name: e.name }))); }}>
                  <Upload size={12} className="rotate-90" />
                </IconButton>
                <ArrowLeftRight size={11} className="text-fg-4" />
                <IconButton label="← Download selection" size="xs" onClick={() => { const s = remote.current?.selection() ?? []; if (s.length) void download(s); }}>
                  <Download size={12} className="rotate-90" />
                </IconButton>
              </div>
              <Resizer
                dir="row"
                onDrag={(d) => {
                  const w = container.current?.clientWidth ?? 1000;
                  setSplit((s) => Math.max(20, Math.min(75, s + (d / w) * 100)));
                }}
                onEnd={() => update(tab.id, { split })}
              />
            </>
          )}
          <div className="flex flex-1 min-w-0 min-h-0">
            <FilePane
              ref={remote}
              side="remote"
              serverId={serverId}
              initialPath={tab.data.remotePath ?? null}
              onPathChange={(p) => update(tab.id, { remotePath: p })}
              onOpenFile={openFile}
              onTransfer={(entries) => void download(entries)}
              onDropFiles={(_p, data) => data?.side === "local" && void upload(data.entries.map((e) => ({ path: e.path, name: e.name })))}
              onActivate={() => setActiveSide("remote")}
              active={activeSide === "remote"}
              otherLabel="This PC"
            />
          </div>
        </div>
        {osDrag && <div className="sr-only">Dropping onto {osDrag}</div>}
      </div>
    </ConnectGate>
  );
}

export function LocalFilesView({ tab }: { tab: Tab }) {
  const update = useWorkspace((s) => s.updateTab);
  return (
    <div className="flex h-full min-h-0">
      <FilePane side="local" initialPath={tab.data.localPath ?? null} onPathChange={(p) => update(tab.id, { localPath: p })} active />
    </div>
  );
}
