import { useState } from "react";
import { AlertTriangle, ChevronRight, Copy } from "lucide-react";
import type { AppError } from "@/types/generated";
import { cn } from "@/lib/format";
import { platform } from "@/services/platform";
import { Button } from "./ui";

/**
 * Human-first error presentation: title, plain explanation, likely causes, and
 * the raw technical details hidden behind an expandable section.
 */
export function ErrorView({ error, compact, className, actions }: { error: AppError; compact?: boolean; className?: string; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("rounded-lg border border-danger/25 bg-danger/[0.06] text-left", compact ? "p-3" : "p-4", className)} role="alert">
      <div className="flex gap-3">
        <AlertTriangle size={compact ? 16 : 18} className="text-danger shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className={cn("font-semibold text-fg", compact ? "text-[13px]" : "text-[14px]")}>{error.title}</div>
          <p className="text-[12.5px] text-fg-2 mt-0.5 selectable">{error.message}</p>
          {error.causes?.length > 0 && (
            <div className="mt-2.5">
              <div className="text-[11px] font-semibold text-fg-3 uppercase tracking-wider mb-1">Possible causes</div>
              <ul className="space-y-0.5">
                {error.causes.map((c, i) => (
                  <li key={i} className="text-[12.5px] text-fg-2 flex gap-2 selectable">
                    <span className="text-fg-4">•</span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error.details && (
            <div className="mt-2.5">
              <button className="inline-flex items-center gap-1 text-[11.5px] text-fg-3 hover:text-fg-2" onClick={() => setOpen(!open)} aria-expanded={open}>
                <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
                Technical details
              </button>
              {open && (
                <div className="relative mt-1.5 anim-fade">
                  <pre className="text-[11.5px] font-mono text-fg-3 bg-bg-0 border border-line rounded-md p-2 pr-8 whitespace-pre-wrap break-all max-h-48 overflow-auto selectable">{error.details}</pre>
                  <button className="absolute top-1.5 right-1.5 p-1 text-fg-3 hover:text-fg" title="Copy" onClick={() => platform.writeClipboard(`${error.title}: ${error.message}\n${error.details}`)}>
                    <Copy size={12} />
                  </button>
                </div>
              )}
            </div>
          )}
          {actions && <div className="flex gap-2 mt-3">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

export function ErrorPanel({ error, onRetry, className }: { error: AppError; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("flex-1 flex items-center justify-center p-8", className)}>
      <ErrorView error={error} className="max-w-[560px] w-full" actions={onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>} />
    </div>
  );
}
