import { useRef, type ReactNode } from "react";
import { Plug, RefreshCw } from "lucide-react";
import type { AppError } from "@/types/generated";
import { useConnState, useServers } from "@/stores/servers";
import { Button, Spinner } from "@/components/ui";
import { ErrorView } from "@/components/ErrorView";
import { cn } from "@/lib/format";
import { connectServer } from "./actions";

/**
 * Shows children while the server is connected. Before the first connection it
 * explains and offers to connect. Once content has been shown it stays mounted
 * (so unsaved editor text, scroll positions and selections survive) and an
 * overlay explains reconnects/failures.
 */
export function ConnectGate({ serverId, what, children }: { serverId: string; what: string; children: ReactNode }) {
  const state = useConnState(serverId);
  const server = useServers((s) => s.servers.find((x) => x.id === serverId));
  const status = useServers((s) => s.statuses[serverId]);
  const seen = useRef(false);
  if (state === "connected") seen.current = true;

  const failed = state === "failed" ? (status!.state as { error: AppError }).error : null;
  const gate = (
    <div className="flex flex-col items-center text-center gap-3">
      {failed ? (
        <ErrorView
          error={failed}
          className="max-w-[540px] w-full"
          actions={
            <Button size="sm" variant="primary" icon={<RefreshCw size={13} />} onClick={() => void connectServer(serverId)}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <div className="h-12 w-12 rounded-2xl bg-bg-3 border border-line flex items-center justify-center text-fg-3">{state === "connecting" ? <Spinner size={18} className="text-accent" /> : <Plug size={20} />}</div>
          <div className="text-[14px] font-semibold text-fg">{state === "connecting" ? `Connecting to ${server?.name}…` : `Connect to ${server?.name ?? "the server"} to ${what}`}</div>
          <div className="text-[12.5px] text-fg-3 font-mono">
            {server?.username}@{server?.host}
          </div>
          {state !== "connecting" && (
            <Button variant="primary" icon={<Plug size={14} />} onClick={() => void connectServer(serverId)} data-testid="gate-connect">
              {seen.current ? "Reconnect" : "Connect"}
            </Button>
          )}
        </>
      )}
    </div>
  );

  if (!seen.current) return <div className="h-full flex items-center justify-center p-8 anim-fade">{gate}</div>;

  return (
    <div className="relative h-full flex flex-col min-h-0">
      {state === "reconnecting" && (
        <div className="flex items-center justify-center gap-2 h-8 bg-warn/10 text-warn text-[12px] border-b border-warn/20 shrink-0 anim-fade">
          <Spinner size={12} className="text-warn" /> Connection lost — reconnecting to {server?.name}… your work here is kept.
        </div>
      )}
      <div className={cn("flex-1 min-h-0 flex flex-col", state !== "connected" && "pointer-events-none opacity-60")}>{children}</div>
      {state !== "connected" && state !== "reconnecting" && <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-0/70 backdrop-blur-[1px] p-8 anim-fade">{gate}</div>}
    </div>
  );
}
