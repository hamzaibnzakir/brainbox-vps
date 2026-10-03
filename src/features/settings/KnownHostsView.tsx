import { KeyRound, Trash2 } from "lucide-react";
import type { KnownHost } from "@/types/generated";
import { api } from "@/services/api";
import { useUi } from "@/stores/ui";
import { useAsync } from "@/hooks/useAsync";
import { DataTable } from "@/components/DataTable";
import { EmptyState, IconButton, Toolbar } from "@/components/ui";
import { formatDate } from "@/lib/format";

export function KnownHostsView() {
  const list = useAsync(() => api.knownHostsList(), []);
  const forget = async (k: KnownHost) => {
    if (!(await useUi.getState().confirm({ title: `Forget ${k.host}:${k.port}?`, message: "You will be asked to verify this server's key again on the next connection.", confirmLabel: "Forget", danger: true }))) return;
    await api.knownHostForget(k.host, k.port);
    void list.reload();
  };
  return (
    <div className="flex flex-col h-full min-h-0">
      <Toolbar>
        <KeyRound size={15} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">Known hosts</span>
        <span className="text-[12px] text-fg-3">Server keys you have trusted. Brainbox also honours your ~/.ssh/known_hosts.</span>
      </Toolbar>
      <DataTable
        rows={list.data ?? []}
        rowKey={(k) => `${k.host}:${k.port}:${k.algorithm}`}
        columns={[
          { key: "host", header: "Host", width: "minmax(160px,1fr)", sort: (a, b) => a.host.localeCompare(b.host), render: (k) => <span className="font-mono text-fg">{k.host}:{k.port}</span> },
          { key: "alg", header: "Type", width: 140, render: (k) => k.algorithm },
          { key: "fp", header: "Fingerprint", width: "minmax(260px,2fr)", render: (k) => <span className="font-mono text-[11.5px] text-fg-3 selectable">{k.fingerprint}</span> },
          { key: "added", header: "Trusted", width: 140, render: (k) => <span className="text-fg-3">{formatDate(k.addedAt)}</span> },
          { key: "x", header: "", width: 50, align: "right", render: (k) => <IconButton label="Forget" size="xs" tone="danger" onClick={() => void forget(k)}><Trash2 size={12} /></IconButton> },
        ]}
        empty={<EmptyState icon={<KeyRound size={20} />} title="No trusted keys yet" body="When you connect to a new server you'll be asked to verify its fingerprint." />}
      />
    </div>
  );
}
