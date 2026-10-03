import { useState } from "react";
import { Fingerprint, ShieldAlert, ShieldQuestion } from "lucide-react";
import type { HostKeyDecision } from "@/types/generated";
import { api } from "@/services/api";
import { useServers } from "@/stores/servers";
import { useUi } from "@/stores/ui";
import { Modal } from "@/components/Modal";
import { Button, Input } from "@/components/ui";

/** Shown when a server presents an unknown — or changed — SSH host key. */
export function HostKeyDialog() {
  const prompts = useUi((s) => s.hostKeys);
  const pop = useUi((s) => s.popHostKey);
  const p = prompts[0];
  const server = useServers((s) => s.servers.find((x) => x.id === p?.serverId));
  const [typed, setTyped] = useState("");
  if (!p) return null;
  const changed = !!p.previousFingerprint;
  const answer = (d: HostKeyDecision) => {
    void api.hostKeyAnswer(p.requestId, d);
    pop(p.requestId, d);
    setTyped("");
  };
  return (
    <Modal
      open
      onClose={() => answer("reject")}
      closeOnBackdrop={false}
      title={changed ? "Warning: server identity has changed" : "Verify the server's identity"}
      subtitle={`${server?.name ?? p.host} · ${p.host}:${p.port}`}
      icon={changed ? <ShieldAlert size={18} className="text-danger" /> : <ShieldQuestion size={18} />}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer("reject")} data-testid="hostkey-reject">
            {changed ? "Disconnect (recommended)" : "Cancel"}
          </Button>
          {!changed && (
            <Button onClick={() => answer("once")} data-testid="hostkey-once">
              Connect once
            </Button>
          )}
          <Button variant={changed ? "danger" : "primary"} data-primary={!changed || undefined} disabled={changed && typed !== p.host} onClick={() => answer("trust")} data-testid="hostkey-trust">
            {changed ? "Trust new key" : "Trust & connect"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-fg-2">
        {changed ? (
          <div className="rounded-lg border border-danger/30 bg-danger/[0.07] p-3 space-y-1.5">
            <p className="text-fg font-medium">The key this server presented does not match the one you trusted before.</p>
            <p>This happens when a server is reinstalled or its SSH keys are regenerated — but it can also mean someone is intercepting your connection. Only continue if you know why the key changed.</p>
          </div>
        ) : (
          <p>This is the first time Brainbox connects to this server. Compare the fingerprint below with the one shown by your hosting provider or by running <code className="font-mono text-fg">ssh-keygen -lf /etc/ssh/ssh_host_{p.algorithm.replace("ssh-", "").replace("ecdsa-sha2-nistp256", "ecdsa")}_key.pub</code> on the server.</p>
        )}
        <div className="rounded-lg border border-line bg-bg-1 p-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">
            <Fingerprint size={13} /> {p.algorithm}
          </div>
          <div className="font-mono text-[12.5px] text-fg break-all selectable" data-testid="hostkey-fingerprint">
            {p.fingerprint}
          </div>
          {changed && (
            <>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-3 pt-1">Previously trusted</div>
              <div className="font-mono text-[12.5px] text-fg-3 break-all line-through decoration-danger/60 selectable">{p.previousFingerprint}</div>
            </>
          )}
        </div>
        {changed && (
          <div className="space-y-1.5">
            <div className="text-[12px]">
              To trust the new key, type <span className="font-mono text-fg">{p.host}</span>:
            </div>
            <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={p.host} />
          </div>
        )}
      </div>
    </Modal>
  );
}
