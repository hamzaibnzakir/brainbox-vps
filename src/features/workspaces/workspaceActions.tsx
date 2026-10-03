import { useState } from "react";
import { Layers } from "lucide-react";
import { useServers } from "@/stores/servers";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Modal } from "@/components/Modal";
import { Avatar, Button, Checkbox, Field, Input } from "@/components/ui";

function ServerPicker({ title, initialName, initialIds, showName, onDone }: { title: string; initialName?: string; initialIds: string[]; showName: boolean; onDone: (r?: { name: string; ids: string[] }) => void }) {
  const servers = useServers((s) => s.servers);
  const [name, setName] = useState(initialName ?? "");
  const [ids, setIds] = useState<Set<string>>(new Set(initialIds));
  return (
    <Modal
      open
      onClose={() => onDone()}
      title={title}
      icon={<Layers size={18} />}
      subtitle="A workspace groups the servers you work on together and remembers your tabs, terminals and layout."
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
          <Button variant="primary" disabled={showName && !name.trim()} onClick={() => onDone({ name: name.trim(), ids: [...ids] })}>
            {showName ? "Create workspace" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {showName && (
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shopify Infrastructure" />
          </Field>
        )}
        <Field label="Servers in this workspace" hint="Leave empty to show all servers.">
          <div className="max-h-64 overflow-auto rounded-md border border-line divide-y divide-line">
            {servers.map((s) => (
              <label key={s.id} className="flex items-center gap-3 px-3 h-10 hover:bg-bg-3">
                <Checkbox
                  checked={ids.has(s.id)}
                  onChange={(v) => {
                    const n = new Set(ids);
                    if (v) n.add(s.id);
                    else n.delete(s.id);
                    setIds(n);
                  }}
                />
                <Avatar name={s.name} color={s.color} size={22} />
                <span className="text-[13px] text-fg flex-1 truncate">{s.name}</span>
                <span className="text-[11.5px] text-fg-3 font-mono truncate">{s.host}</span>
              </label>
            ))}
            {!servers.length && <div className="p-4 text-center text-[12.5px] text-fg-3">No servers yet.</div>}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

export async function newWorkspace() {
  const r = await useUi.getState().custom<{ name: string; ids: string[] }>((close) => <ServerPicker title="New workspace" initialIds={[]} showName onDone={close} />);
  if (!r) return;
  const ws = useWorkspace.getState();
  const w = await ws.createWorkspace(r.name, r.ids);
  await ws.switchWorkspace(w.id);
}

export async function manageWorkspaceServers(id: string) {
  const ws = useWorkspace.getState();
  const w = ws.workspaces.find((x) => x.id === id);
  if (!w) return;
  const r = await useUi.getState().custom<{ name: string; ids: string[] }>((close) => <ServerPicker title={`Servers in “${w.name}”`} initialIds={w.serverIds} showName={false} onDone={close} />);
  if (r) await ws.setWorkspaceServers(id, r.ids);
}
