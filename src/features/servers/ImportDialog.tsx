import { useEffect, useState } from "react";
import { Download, FileCode2 } from "lucide-react";
import type { SshConfigHost } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { useServers } from "@/stores/servers";
import { toastError, useUi } from "@/stores/ui";
import { Modal } from "@/components/Modal";
import { Badge, Button, Checkbox, EmptyState, Spinner } from "@/components/ui";

export function ImportDialog() {
  const open = useUi((s) => s.importOpen);
  const set = useUi((s) => s.set);
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setHosts(null);
    void api
      .sshConfigScan()
      .then((h) => {
        setHosts(h);
        setPicked(new Set(h.filter((x) => !x.alreadyImported).map((x) => x.alias)));
      })
      .catch((e) => {
        toastError(toAppError(e));
        setHosts([]);
      });
  }, [open]);
  const close = () => set({ importOpen: false });
  const doImport = async () => {
    setBusy(true);
    try {
      const list = (hosts ?? []).filter((h) => picked.has(h.alias));
      const created = await api.sshConfigImport(list);
      await useServers.getState().load();
      useUi.getState().toast({ kind: "success", title: `Imported ${created.length} server${created.length === 1 ? "" : "s"}` });
      close();
    } catch (e) {
      toastError(toAppError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Import from OpenSSH config"
      subtitle="Hosts from ~/.ssh/config (HostName, Port, User, IdentityFile and ProxyJump are imported)."
      icon={<Download size={18} />}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!picked.size} onClick={() => void doImport()}>
            Import {picked.size || ""} host{picked.size === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      {!hosts ? (
        <div className="py-8 flex justify-center">
          <Spinner />
        </div>
      ) : !hosts.length ? (
        <EmptyState icon={<FileCode2 size={20} />} title="No hosts found" body="Brainbox looked for ~/.ssh/config on this computer and found no Host entries." />
      ) : (
        <div className="rounded-md border border-line divide-y divide-line max-h-[50vh] overflow-auto">
          {hosts.map((h) => (
            <label key={h.alias} className="flex items-center gap-3 px-3 py-2 hover:bg-bg-3">
              <Checkbox
                checked={picked.has(h.alias)}
                onChange={(v) => {
                  const n = new Set(picked);
                  if (v) n.add(h.alias);
                  else n.delete(h.alias);
                  setPicked(n);
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-fg">{h.alias}</span>
                  {h.alreadyImported && <Badge>already added</Badge>}
                  {h.proxyJump && <Badge tone="info">via {h.proxyJump}</Badge>}
                </div>
                <div className="text-[11.5px] font-mono text-fg-3 truncate">
                  {h.username ? `${h.username}@` : ""}
                  {h.host}:{h.port} {h.identityFile && `· ${h.identityFile}`}
                </div>
              </div>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
