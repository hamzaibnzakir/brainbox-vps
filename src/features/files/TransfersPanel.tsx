import { ArrowDown, ArrowUp, CheckCircle2, Folder, FolderOpen, Pause, Play, RotateCw, X, XCircle, Trash2, ChevronDown, AlertTriangle } from "lucide-react";
import type { TransferInfo } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { useTransfers } from "@/stores/data";
import { useServers } from "@/stores/servers";
import { toastError, useUi } from "@/stores/ui";
import { Button, EmptyState, IconButton, Progress } from "@/components/ui";
import { Resizer } from "@/components/Split";
import { cn, formatBytes, formatDuration, formatRate } from "@/lib/format";
import { dirname } from "@/lib/paths";

const act = (fn: () => Promise<unknown>) => () => void fn().catch((e) => toastError(toAppError(e)));

function TransferRow({ t }: { t: TransferInfo }) {
  const server = useServers((s) => s.servers.find((x) => x.id === t.serverId));
  const pct = t.totalBytes ? (t.transferredBytes / t.totalBytes) * 100 : t.state === "completed" ? 100 : 0;
  const tone = t.state === "failed" ? "danger" : t.state === "completed" ? "ok" : t.state === "paused" ? "warn" : "accent";
  const showError = useUi((s) => s.showError);
  const stateLabel: Record<TransferInfo["state"], string> = { queued: "Queued", running: "Transferring", paused: "Paused", completed: "Done", failed: "Failed", cancelled: "Cancelled" };
  return (
    <div className="grid grid-cols-[22px_minmax(160px,2fr)_minmax(140px,1.5fr)_90px_80px_70px_auto] items-center gap-3 px-3 h-11 border-b border-line/50 hover:bg-bg-3/50 text-[12px]" data-testid="transfer-row">
      <span className={cn("flex items-center justify-center", t.direction === "upload" ? "text-accent" : "text-info")}>{t.direction === "upload" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-fg truncate">
          {t.isDir && <Folder size={12} className="text-fg-3 shrink-0" />}
          <span className="truncate font-medium">{t.name}</span>
        </div>
        <div className="text-[11px] text-fg-3 truncate" title={t.direction === "upload" ? `${t.localPath} → ${server?.name}:${t.remotePath}` : `${server?.name}:${t.remotePath} → ${t.localPath}`}>
          {t.direction === "upload" ? `→ ${server?.name ?? "server"}:${dirname(t.remotePath)}` : `← ${dirname(t.localPath)}`}
          {t.isDir && t.filesTotal > 0 && ` · ${t.filesDone}/${t.filesTotal} files`}
        </div>
      </div>
      <div className="min-w-0">
        <Progress value={pct} tone={tone} />
        <div className="mt-1 flex justify-between text-[10.5px] text-fg-3 tabular">
          <span>
            {formatBytes(t.transferredBytes)} / {formatBytes(t.totalBytes)}
          </span>
          <span>{pct.toFixed(0)}%</span>
        </div>
      </div>
      <span className="tabular text-fg-2">{t.state === "running" ? formatRate(t.speedBps) : "—"}</span>
      <span className="tabular text-fg-3">{t.state === "running" && t.etaSecs != null ? formatDuration(t.etaSecs) : t.state === "running" ? "…" : "—"}</span>
      <span className={cn("text-[11px] font-medium flex items-center gap-1", t.state === "failed" ? "text-danger" : t.state === "completed" ? "text-ok" : t.state === "paused" ? "text-warn" : "text-fg-3")}>
        {t.state === "completed" && <CheckCircle2 size={12} />}
        {t.state === "failed" && <XCircle size={12} />}
        {stateLabel[t.state]}
      </span>
      <div className="flex items-center gap-0.5 justify-end">
        {t.state === "failed" && t.error && (
          <IconButton label="Error details" size="xs" onClick={() => void showError(t.error!)}>
            <AlertTriangle size={13} className="text-danger" />
          </IconButton>
        )}
        {(t.state === "running" || t.state === "queued") && (
          <IconButton label="Pause" size="xs" onClick={act(() => api.transferPause(t.id))}>
            <Pause size={13} />
          </IconButton>
        )}
        {t.state === "paused" && (
          <IconButton label="Resume" size="xs" onClick={act(() => api.transferResume(t.id))}>
            <Play size={13} />
          </IconButton>
        )}
        {t.state === "failed" && (
          <IconButton label="Retry (continues where it stopped)" size="xs" onClick={act(() => api.transferRetry(t.id))}>
            <RotateCw size={13} />
          </IconButton>
        )}
        {t.state === "completed" && t.direction === "download" && (
          <IconButton label="Show in folder" size="xs" onClick={act(() => api.localReveal(t.localPath))}>
            <FolderOpen size={13} />
          </IconButton>
        )}
        {!["completed", "cancelled"].includes(t.state) && (
          <IconButton label="Cancel" size="xs" tone="danger" onClick={act(() => api.transferCancel(t.id))}>
            <X size={13} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

export function TransfersPanel() {
  const { items, order, clearFinished } = useTransfers();
  const ui = useUi();
  const list = order.map((id) => items[id]).filter(Boolean);
  const running = list.filter((t) => t.state === "running" || t.state === "queued").length;
  if (!ui.bottomOpen) return null;
  return (
    <>
      <Resizer dir="column" onDrag={(d) => ui.set({ bottomHeight: Math.max(120, Math.min(600, useUi.getState().bottomHeight - d)) })} />
      <section className="flex flex-col bg-bg-1 shrink-0 min-h-0" style={{ height: ui.bottomHeight }} aria-label="Transfers" data-testid="transfers-panel">
        <div className="flex items-center gap-2 h-8 px-3 border-b border-line shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-2">Transfers</span>
          {running > 0 && <span className="text-[11px] text-accent">{running} active</span>}
          <div className="flex-1" />
          <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void clearFinished()} disabled={!list.some((t) => t.state === "completed" || t.state === "cancelled")}>
            Clear finished
          </Button>
          <IconButton label="Hide panel (Ctrl+J)" size="xs" onClick={() => ui.set({ bottomOpen: false })}>
            <ChevronDown size={14} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {list.length === 0 ? (
            <EmptyState title="No transfers" body="Uploads and downloads appear here and keep running while you work in other tabs." className="py-6" />
          ) : (
            list.map((t) => <TransferRow key={t.id} t={t} />)
          )}
        </div>
      </section>
    </>
  );
}
