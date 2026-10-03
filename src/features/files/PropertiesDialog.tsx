import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { FileEntry } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { toastError, useUi } from "@/stores/ui";
import { Modal } from "@/components/Modal";
import { Button, Checkbox, Input, Spinner } from "@/components/ui";
import { formatBytes, formatDate, permString } from "@/lib/format";
import type { Side } from "./FilePane";

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-1.5 border-b border-line/60 text-[12.5px]">
      <span className="text-fg-3">{k}</span>
      <span className="text-fg break-all selectable">{v}</span>
    </div>
  );
}

function Props({ e, side, serverId, onDone }: { e: FileEntry; side: Side; serverId?: string; onDone: (changed?: boolean) => void }) {
  const isDir = e.kind === "dir" || e.linkIsDir;
  const [size, setSize] = useState<number | null>(isDir ? null : e.size);
  const [sizing, setSizing] = useState(false);
  const [mode, setMode] = useState(e.permissions ?? 0o644);
  const [octal, setOctal] = useState((e.permissions ?? 0o644).toString(8).padStart(3, "0"));
  const [saving, setSaving] = useState(false);
  useEffect(() => setOctal(mode.toString(8).padStart(3, "0")), [mode]);
  const bit = (b: number) => (mode & b) !== 0;
  const toggle = (b: number) => setMode(mode ^ b);
  const grid: Array<[string, number, number, number]> = [
    ["Owner", 0o400, 0o200, 0o100],
    ["Group", 0o040, 0o020, 0o010],
    ["Others", 0o004, 0o002, 0o001],
  ];
  const changed = side === "remote" && e.permissions != null && mode !== e.permissions;
  return (
    <Modal
      open
      onClose={() => onDone()}
      title={e.name}
      subtitle={isDir ? "Folder" : "File"}
      icon={<Info size={18} />}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone()}>
            Close
          </Button>
          {side === "remote" && (
            <Button
              variant="primary"
              disabled={!changed}
              loading={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await api.sftpChmod(serverId!, e.path, mode);
                  useUi.getState().toast({ kind: "success", title: `Permissions set to ${octal}` });
                  onDone(true);
                } catch (er) {
                  toastError(toAppError(er));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Apply permissions
            </Button>
          )}
        </>
      }
    >
      <div>
        <Row k="Location" v={<span className="font-mono text-[12px]">{e.path}</span>} />
        <Row
          k="Size"
          v={
            size != null ? (
              `${formatBytes(size)} (${size.toLocaleString()} bytes)`
            ) : side === "remote" ? (
              <button
                className="text-accent hover:underline inline-flex items-center gap-1.5"
                onClick={async () => {
                  setSizing(true);
                  try {
                    setSize(await api.sftpDirSize(serverId!, e.path));
                  } catch (er) {
                    toastError(toAppError(er));
                  } finally {
                    setSizing(false);
                  }
                }}
              >
                {sizing && <Spinner size={12} />} Calculate folder size
              </button>
            ) : (
              "—"
            )
          }
        />
        <Row k="Modified" v={formatDate(e.modified)} />
        {e.owner && <Row k="Owner" v={`${e.owner}${e.group ? ` : ${e.group}` : ""}`} />}
        {e.permissions != null && <Row k="Permissions" v={<span className="font-mono">{permString(mode, isDir)} ({octal})</span>} />}
      </div>
      {side === "remote" && e.permissions != null && (
        <div className="mt-4">
          <div className="grid grid-cols-[80px_repeat(3,1fr)] gap-y-2 text-[12.5px] items-center">
            <span />
            <span className="text-fg-3 text-[11px] uppercase">Read</span>
            <span className="text-fg-3 text-[11px] uppercase">Write</span>
            <span className="text-fg-3 text-[11px] uppercase">Execute</span>
            {grid.map(([label, r, w, x]) => (
              <div key={label} className="contents">
                <span className="text-fg-2">{label}</span>
                <Checkbox checked={bit(r)} onChange={() => toggle(r)} />
                <Checkbox checked={bit(w)} onChange={() => toggle(w)} />
                <Checkbox checked={bit(x)} onChange={() => toggle(x)} />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[12px] text-fg-3">Octal</span>
            <Input
              mono
              className="w-20"
              value={octal}
              onChange={(ev) => {
                const v = ev.target.value.replace(/[^0-7]/g, "").slice(0, 4);
                setOctal(v);
                if (v.length >= 3) setMode(parseInt(v, 8));
              }}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}

export function showProperties(e: FileEntry, side: Side, serverId: string | undefined, refresh: () => void) {
  void useUi.getState().custom<boolean>((close) => <Props e={e} side={side} serverId={serverId} onDone={(c) => close(c)} />).then((c) => c && refresh());
}
