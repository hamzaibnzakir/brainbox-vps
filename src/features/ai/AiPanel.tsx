import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, ChevronRight, Loader2, Play, RotateCcw, Send, ShieldCheck, Sparkles, Wrench, X, XCircle } from "lucide-react";
import type { AiChatItem, AiProposal, AppError } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { useServers, useConnState } from "@/stores/servers";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { Avatar, Badge, Button, IconButton, Select } from "@/components/ui";
import { ErrorView } from "@/components/ErrorView";
import { Resizer } from "@/components/Split";
import { cn } from "@/lib/format";
import { connectServer } from "../servers/actions";

const SUGGESTIONS = ["Why is my server slow?", "Check whether nginx is running.", "Why is Docker using so much RAM?", "Show me the largest directories.", "Are there any failed services?"];

function ToolItem({ item }: { item: Extract<AiChatItem, { role: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-bg-1 text-[12px]">
      <button className="w-full flex items-center gap-2 px-2.5 h-8 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} className={cn("text-fg-3 transition-transform", open && "rotate-90")} />
        {item.ok ? <Wrench size={12} className="text-fg-3" /> : <XCircle size={12} className="text-warn" />}
        <span className="font-mono text-fg-2">{item.name}</span>
        {item.input && <span className="text-fg-4 truncate">{item.input}</span>}
      </button>
      {open && <pre className="px-3 pb-2.5 font-mono text-[11.5px] text-fg-3 whitespace-pre-wrap break-all max-h-64 overflow-auto selectable">{item.output}</pre>}
    </div>
  );
}

function ProposalCard({ p, status, onDecide, busy }: { p: AiProposal; status: string; onDecide: (approve: boolean) => void; busy: boolean }) {
  const pending = status === "pending";
  return (
    <div className={cn("rounded-lg border p-3 space-y-2", p.risk === "dangerous" ? "border-danger/40 bg-danger/[0.06]" : "border-accent/40 bg-accent-softer")} data-testid="ai-proposal">
      <div className="flex items-center gap-2">
        <ShieldCheck size={14} className="text-accent" />
        <span className="text-[12px] font-semibold text-fg">Proposed command</span>
        {p.risk === "dangerous" ? <Badge tone="danger">dangerous</Badge> : <Badge tone="warn">changes server</Badge>}
        <span className="flex-1" />
        {status === "executed" && <Badge tone="ok">ran</Badge>}
        {status === "failed" && <Badge tone="danger">failed</Badge>}
        {status === "rejected" && <Badge>rejected</Badge>}
      </div>
      <pre className="font-mono text-[12px] bg-bg-0 border border-line rounded-md px-2.5 py-2 text-fg whitespace-pre-wrap break-all selectable">{p.command}</pre>
      {p.reason && <p className="text-[12px] text-fg-2">{p.reason}</p>}
      {pending && (
        <div className="flex gap-2">
          <Button size="sm" variant={p.risk === "dangerous" ? "danger" : "primary"} icon={<Play size={12} />} loading={busy} onClick={() => onDecide(true)} data-testid="ai-approve">
            Approve & run
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={12} />} disabled={busy} onClick={() => onDecide(false)}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

export function AiPanel() {
  const ui = useUi();
  const ai = useSettings((s) => s.settings.ai);
  const servers = useServers((s) => s.servers);
  const activeServer = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId)?.serverId ?? s.selectedServerId);
  const [serverId, setServerId] = useState<string | null>(activeServer ?? null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [items, setItems] = useState<AiChatItem[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const state = useConnState(serverId);
  useEffect(() => {
    if (!chatId && activeServer) setServerId(activeServer);
  }, [activeServer, chatId]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [items, busy]);

  if (!ui.aiOpen) return null;
  const server = servers.find((s) => s.id === serverId);

  const reset = () => {
    if (chatId) void api.aiDeleteChat(chatId);
    setChatId(null);
    setItems([]);
    setError(null);
  };

  const send = async (msg: string) => {
    if (!msg.trim() || !serverId || busy) return;
    setError(null);
    setBusy(true);
    setItems((i) => [...i, { role: "user", text: msg }]);
    setText("");
    try {
      if (state !== "connected" && !(await connectServer(serverId))) throw { code: "not_connected", title: "Not connected", message: "Connect to the server first.", causes: [], details: null };
      let id = chatId;
      if (!id) {
        id = await api.aiNewChat(serverId);
        setChatId(id);
      }
      const r = await api.aiSend(id, msg);
      setItems(r.items);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (p: AiProposal, approve: boolean) => {
    if (!chatId) return;
    setBusy(true);
    try {
      const r = await api.aiDecide(chatId, p.id, approve);
      setItems(r.items);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Resizer dir="row" onDrag={(d) => ui.set({ aiWidth: Math.max(320, Math.min(720, useUi.getState().aiWidth - d)) })} />
      <aside className="flex flex-col bg-bg-1 shrink-0 min-h-0" style={{ width: ui.aiWidth }} aria-label="Brainbox AI" data-testid="ai-panel">
        <div className="flex items-center gap-2 h-11 px-3 border-b border-line shrink-0">
          <div className="h-6 w-6 rounded-md bg-gradient-to-br from-accent to-info flex items-center justify-center">
            <Sparkles size={13} className="text-white" />
          </div>
          <span className="text-[13px] font-semibold text-fg">Brainbox AI</span>
          <div className="flex-1" />
          <IconButton label="New conversation" size="xs" onClick={reset}>
            <RotateCcw size={13} />
          </IconButton>
          <IconButton label="Close (Ctrl+I)" size="xs" onClick={() => ui.set({ aiOpen: false })}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="px-3 py-2 border-b border-line flex items-center gap-2">
          {server && <Avatar name={server.name} color={server.color} size={20} />}
          <Select
            value={serverId ?? ""}
            onChange={(e) => {
              reset();
              setServerId(e.target.value || null);
            }}
            className="flex-1 h-7 text-[12px]"
          >
            <option value="">Choose a server…</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        {!ai.enabled ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-3">
            <Bot size={28} className="text-fg-3" />
            <div className="text-[13.5px] font-semibold text-fg">Brainbox AI is off</div>
            <p className="text-[12.5px] text-fg-3">Connect an Anthropic or OpenAI-compatible model. It can only inspect servers with read-only tools, and every change needs your approval.</p>
            <Button variant="primary" size="sm" onClick={() => useWorkspace.getState().openTab("settings")}>
              Set up in Settings
            </Button>
          </div>
        ) : (
          <>
            <div ref={scroller} className="flex-1 overflow-auto p-3 space-y-3">
              {items.length === 0 && (
                <div className="space-y-3 pt-4 anim-fade">
                  <div className="text-center">
                    <Sparkles size={22} className="text-accent mx-auto" />
                    <div className="text-[13.5px] font-semibold text-fg mt-2">Ask about {server?.name ?? "a server"}</div>
                    <p className="text-[12px] text-fg-3 mt-1">I investigate with read-only checks first. Anything that changes the server is shown to you for approval.</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} disabled={!serverId} onClick={() => void send(s)} className="text-left text-[12.5px] px-3 py-2 rounded-lg border border-line bg-bg-2 hover:border-accent/50 hover:bg-accent-softer text-fg-2 disabled:opacity-50">
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {items.map((it, i) => {
                if (it.role === "user")
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent text-white px-3 py-2 text-[13px] selectable">{it.text}</div>
                    </div>
                  );
                if (it.role === "assistant")
                  return (
                    <div key={i} className="md text-[13px] text-fg leading-relaxed selectable">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
                    </div>
                  );
                if (it.role === "tool") return <ToolItem key={i} item={it} />;
                return <ProposalCard key={i} p={it.proposal} status={it.status} busy={busy} onDecide={(a) => void decide(it.proposal, a)} />;
              })}
              {busy && (
                <div className="flex items-center gap-2 text-[12px] text-fg-3">
                  <Loader2 size={13} className="anim-spin text-accent" /> Thinking…
                </div>
              )}
              {error && <ErrorView error={error} compact />}
            </div>
            <form
              className="p-3 border-t border-line"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <div className="relative">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                  rows={2}
                  placeholder={serverId ? "Ask anything about this server…" : "Choose a server first"}
                  disabled={!serverId}
                  className="w-full resize-none rounded-lg bg-bg-0 border border-line-2 focus:border-accent px-3 py-2 pr-10 text-[13px] text-fg placeholder:text-fg-4"
                  data-testid="ai-input"
                />
                <button type="submit" disabled={!text.trim() || busy || !serverId} className="absolute right-2 bottom-2.5 h-7 w-7 rounded-md bg-accent text-white flex items-center justify-center disabled:opacity-40" aria-label="Send">
                  <Send size={13} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 text-[10.5px] text-fg-4">
                <Check size={10} /> Read-only by default · secrets redacted · {ai.model}
              </div>
            </form>
          </>
        )}
      </aside>
    </>
  );
}
