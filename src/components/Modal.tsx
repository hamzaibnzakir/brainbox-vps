import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/format";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  width = 520,
  className,
  closeOnBackdrop = true,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  closeOnBackdrop?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && ref.current) {
        // Focus trap.
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        const list = Array.from(f).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Autofocus the first field.
    setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>("[autofocus], input:not([type=checkbox]), textarea, select, button[data-primary]");
      el?.focus();
    }, 20);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restore.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[9vh] px-4 anim-fade" onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()} style={{ background: "rgb(0 0 0 / 0.45)", backdropFilter: "blur(2px)" }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn("anim-pop w-full max-h-[82vh] flex flex-col rounded-xl border border-line-2 bg-bg-2 shadow-pop overflow-hidden", className)}
        style={{ maxWidth: width }}
      >
        {(title || icon) && (
          <header className="flex items-start gap-3 px-5 pt-4 pb-3">
            {icon && <div className="h-9 w-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0">{icon}</div>}
            <div className="min-w-0 flex-1">
              <h2 id={labelledBy} className="text-[15px] font-semibold text-fg leading-tight">
                {title}
              </h2>
              {subtitle && <p className="text-[12.5px] text-fg-3 mt-0.5">{subtitle}</p>}
            </div>
            <button onClick={onClose} className="text-fg-3 hover:text-fg p-1 -mr-1 rounded hover:bg-bg-4" aria-label="Close">
              <X size={16} />
            </button>
          </header>
        )}
        <div className="px-5 pb-4 overflow-auto flex-1 min-h-0">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-bg-1/60">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
