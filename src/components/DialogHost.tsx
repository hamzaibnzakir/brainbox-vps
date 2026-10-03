import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, X, XCircle } from "lucide-react";
import { createPortal } from "react-dom";
import { useUi, type Dialog, type Toast } from "@/stores/ui";
import { cn } from "@/lib/format";
import { Modal } from "./Modal";
import { ErrorView } from "./ErrorView";
import { Button, Checkbox, Field, Input } from "./ui";

function ConfirmDialog({ d }: { d: Extract<Dialog, { type: "confirm" }> }) {
  const close = useUi((s) => s.closeDialog);
  const [typed, setTyped] = useState("");
  const done = (ok: boolean) => {
    close(d.id);
    d.resolve(ok);
  };
  const o = d.opts;
  const blocked = !!o.requireText && typed !== o.requireText;
  return (
    <Modal
      open
      onClose={() => done(false)}
      title={o.title}
      icon={o.danger ? <ShieldAlert size={18} className="text-danger" /> : <Info size={18} />}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>
            {o.cancelLabel ?? "Cancel"}
          </Button>
          <Button data-primary variant={o.danger ? "danger" : "primary"} disabled={blocked} onClick={() => done(true)}>
            {o.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-fg-2">
        {o.message && <div className="leading-relaxed">{o.message}</div>}
        {o.command && <pre className="font-mono text-[12px] bg-bg-0 border border-line rounded-md px-3 py-2 text-fg whitespace-pre-wrap break-all selectable">{o.command}</pre>}
        {o.details && o.details.length > 0 && (
          <ul className="space-y-1">
            {o.details.map((x, i) => (
              <li key={i} className="flex gap-2 text-[12.5px]">
                <AlertTriangle size={13} className={cn("mt-0.5 shrink-0", o.danger ? "text-danger" : "text-warn")} />
                {x}
              </li>
            ))}
          </ul>
        )}
        {o.requireText && (
          <Field label={<>Type <span className="font-mono text-fg">{o.requireText}</span> to confirm</>}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus onKeyDown={(e) => e.key === "Enter" && !blocked && done(true)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function PromptDialog({ d }: { d: Extract<Dialog, { type: "prompt" }> }) {
  const close = useUi((s) => s.closeDialog);
  const o = d.opts;
  const [value, setValue] = useState(o.initial ?? "");
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = (ok: boolean) => {
    if (ok) {
      const err = o.validate?.(value) ?? null;
      if (err) return setError(err);
    }
    close(d.id);
    d.resolve(ok ? { value, checked } : null);
  };
  return (
    <Modal
      open
      onClose={() => finish(false)}
      title={o.title}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button data-primary variant="primary" onClick={() => finish(true)}>
            {o.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        {o.message && <div className="text-[13px] text-fg-2 leading-relaxed">{o.message}</div>}
        <Field label={o.label} error={error}>
          <Input
            autoFocus
            type={o.password ? "password" : "text"}
            value={value}
            placeholder={o.placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
        {o.checkbox && <Checkbox checked={checked} onChange={setChecked} label={o.checkbox} />}
      </form>
    </Modal>
  );
}

function ErrorDialog({ d }: { d: Extract<Dialog, { type: "error" }> }) {
  const close = useUi((s) => s.closeDialog);
  const done = () => {
    close(d.id);
    d.resolve();
  };
  return (
    <Modal open onClose={done} width={540} footer={<Button data-primary onClick={done}>OK</Button>}>
      <div className="pt-4">
        <ErrorView error={d.error} />
      </div>
    </Modal>
  );
}

export function DialogHost() {
  const dialogs = useUi((s) => s.dialogs);
  const close = useUi((s) => s.closeDialog);
  return (
    <>
      {dialogs.map((d) => {
        if (d.type === "confirm") return <ConfirmDialog key={d.id} d={d} />;
        if (d.type === "prompt") return <PromptDialog key={d.id} d={d} />;
        if (d.type === "error") return <ErrorDialog key={d.id} d={d} />;
        return (
          <div key={d.id}>
            {d.render((v) => {
              close(d.id);
              d.resolve(v);
            })}
          </div>
        );
      })}
    </>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useUi((s) => s.dismissToast);
  const show = useUi((s) => s.showError);
  const Icon = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle }[t.kind];
  const color = { info: "text-info", success: "text-ok", warning: "text-warn", error: "text-danger" }[t.kind];
  return (
    <div className="pointer-events-auto w-[360px] rounded-lg border border-line-2 bg-bg-2/95 backdrop-blur-md shadow-pop p-3 flex gap-2.5 anim-slide-up" role="status">
      <Icon size={16} className={cn("shrink-0 mt-0.5", color)} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg">{t.title}</div>
        {t.body && <div className="text-[12px] text-fg-3 mt-0.5 line-clamp-3">{t.body}</div>}
        {(t.action || t.error) && (
          <div className="flex gap-3 mt-1.5">
            {t.action && (
              <button
                className="text-[12px] font-medium text-accent hover:underline"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.error && (t.error.causes?.length || t.error.details) && (
              <button
                className="text-[12px] text-fg-3 hover:text-fg-2"
                onClick={() => {
                  dismiss(t.id);
                  void show(t.error!);
                }}
              >
                Details
              </button>
            )}
          </div>
        )}
      </div>
      <button className="text-fg-4 hover:text-fg-2 self-start" onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useUi((s) => s.toasts);
  return createPortal(
    <div className="fixed bottom-9 right-4 z-[150] flex flex-col gap-2 pointer-events-none" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>,
    document.body,
  );
}
