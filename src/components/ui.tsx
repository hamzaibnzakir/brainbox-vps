import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/format";
import { prettyChord } from "@/lib/keys";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "xs" | "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.15)] disabled:hover:bg-accent",
  secondary: "bg-bg-3 text-fg border border-line-2 hover:bg-bg-4 hover:border-line-2",
  ghost: "text-fg-2 hover:text-fg hover:bg-bg-3",
  subtle: "bg-accent-soft text-accent hover:bg-accent-soft hover:brightness-125",
  danger: "bg-danger text-white hover:brightness-110",
};
const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-[11.5px] gap-1 rounded-[5px]",
  sm: "h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-md",
  lg: "h-10 px-4 text-[14px] gap-2 rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-[background,color,border,filter,transform] duration-100 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="anim-spin" size={14} /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "xs" | "sm" | "md"; active?: boolean; tone?: "default" | "danger" }>(
  function IconButton({ label, size = "sm", active, tone = "default", className, children, ...rest }, ref) {
    const s = size === "xs" ? "h-5 w-5 rounded" : size === "sm" ? "h-7 w-7 rounded-md" : "h-8 w-8 rounded-md";
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex items-center justify-center shrink-0 transition-colors duration-100 disabled:opacity-40 disabled:pointer-events-none",
          s,
          active ? "bg-accent-soft text-accent" : tone === "danger" ? "text-fg-3 hover:text-danger hover:bg-danger/10" : "text-fg-3 hover:text-fg hover:bg-bg-4",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; mono?: boolean; leading?: ReactNode }>(function Input({ className, invalid, mono, leading, ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        "h-8 w-full rounded-md bg-bg-1 border px-2.5 text-[13px] text-fg placeholder:text-fg-4 transition-colors",
        "focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)]/30",
        invalid ? "border-danger" : "border-line-2 hover:border-fg-4/50",
        mono && "font-mono text-[12.5px]",
        leading ? "pl-8" : "",
        className,
      )}
      {...rest}
    />
  );
  if (!leading) return input;
  return (
    <div className="relative w-full">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none">{leading}</span>
      {input}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea({ className, mono, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(
        "w-full rounded-md bg-bg-1 border border-line-2 px-2.5 py-2 text-[13px] text-fg placeholder:text-fg-4 resize-y min-h-[64px]",
        "focus:border-accent focus:ring-2 focus:ring-[var(--accent-ring)]/30 hover:border-fg-4/50",
        mono && "font-mono text-[12px]",
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        // Callers may pass their own height/size (cn() doesn't dedupe Tailwind classes).
        /(^|\s)h-/.test(className ?? "") ? "" : "h-8",
        /(^|\s)text-\[/.test(className ?? "") ? "" : "text-[13px]",
        "rounded-md bg-bg-1 border border-line-2 px-2 text-fg hover:border-fg-4/50 focus:border-accent appearance-none pr-7",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-no-repeat bg-[right_8px_center]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50",
        checked ? "bg-accent" : "bg-bg-5",
      )}
    >
      <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-150", checked ? "translate-x-[15px]" : "translate-x-[2px]")} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className={cn("inline-flex items-center gap-2 text-[13px] text-fg-2", disabled && "opacity-50")}>
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--accent)] h-3.5 w-3.5" />
      {label}
    </label>
  );
}

export function Field({ label, hint, error, children, className, required }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-[12px] font-medium text-fg-2">
          {label}
          {required && <span className="text-danger ml-0.5">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="text-[11.5px] text-danger">{error}</p> : hint ? <p className="text-[11.5px] text-fg-3">{hint}</p> : null}
    </div>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "info"; className?: string }) {
  const tones = {
    neutral: "bg-bg-4 text-fg-2",
    accent: "bg-accent-soft text-accent",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/12 text-warn",
    danger: "bg-danger/12 text-danger",
    info: "bg-info/12 text-info",
  };
  return <span className={cn("inline-flex items-center gap-1 h-[18px] px-1.5 rounded text-[10.5px] font-semibold uppercase tracking-wide whitespace-nowrap", tones[tone], className)}>{children}</span>;
}

export type DotState = "connected" | "connecting" | "reconnecting" | "failed" | "disconnected";
export function StatusDot({ state, className, size = 8 }: { state: DotState; className?: string; size?: number }) {
  const color = { connected: "bg-ok", connecting: "bg-warn", reconnecting: "bg-warn", failed: "bg-danger", disconnected: "bg-fg-4" }[state];
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }} aria-label={state}>
      {state === "connected" && <span className="absolute inset-0 rounded-full bg-ok opacity-40 blur-[3px]" />}
      <span className={cn("relative rounded-full w-full h-full", color, (state === "connecting" || state === "reconnecting") && "anim-pulse")} />
    </span>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cn("anim-spin text-fg-3", className)} />;
}

export function Kbd({ chord, className }: { chord: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {prettyChord(chord).map((k, i) => (
        <kbd key={i} className="min-w-[18px] h-[18px] px-1 rounded border border-line-2 bg-bg-3 text-[10.5px] font-sans text-fg-3 inline-flex items-center justify-center leading-none">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center gap-2 p-8 anim-fade", className)}>
      {icon && <div className="mb-1 h-12 w-12 rounded-2xl bg-bg-3 border border-line flex items-center justify-center text-fg-3">{icon}</div>}
      <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
      {body && <div className="text-[12.5px] text-fg-3 max-w-[380px] leading-relaxed">{body}</div>}
      {action && <div className="mt-3 flex gap-2">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "sm" }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; title?: string }>; size?: "sm" | "xs" }) {
  return (
    <div className="inline-flex p-0.5 rounded-md bg-bg-1 border border-line gap-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          title={o.title}
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] font-medium transition-colors inline-flex items-center gap-1.5",
            size === "sm" ? "h-6 px-2.5 text-[12px]" : "h-5 px-2 text-[11px]",
            o.value === value ? "bg-bg-4 text-fg shadow-sm" : "text-fg-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, tone = "accent", className, indeterminate }: { value: number; tone?: "accent" | "ok" | "warn" | "danger"; className?: string; indeterminate?: boolean }) {
  const c = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" }[tone];
  return (
    <div className={cn("h-1.5 w-full rounded-full bg-bg-4 overflow-hidden", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-300", c, indeterminate && "anim-pulse")} style={{ width: `${Math.max(0, Math.min(100, indeterminate ? 100 : value))}%` }} />
    </div>
  );
}

export function usageTone(pct: number): "accent" | "warn" | "danger" | "ok" {
  return pct >= 90 ? "danger" : pct >= 75 ? "warn" : "accent";
}

export function SearchInput({ value, onChange, placeholder = "Search", className, autoFocus, onKeyDown, inputRef }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean; onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <div className={cn("relative", className)}>
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-7 w-full rounded-md bg-bg-1 border border-line pl-7 pr-7 text-[12.5px] text-fg placeholder:text-fg-4 focus:border-accent hover:border-line-2"
      />
      {value && (
        <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg p-0.5" onClick={() => onChange("")} aria-label="Clear search">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-1.5 h-11 px-3 border-b border-line bg-bg-2 shrink-0", className)}>{children}</div>;
}

export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn("rounded-lg border border-line bg-bg-2 flex flex-col min-w-0", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 px-3.5 h-10 border-b border-line">
          <h3 className="text-[12px] font-semibold text-fg-2 uppercase tracking-wider truncate">{title}</h3>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className={cn("flex-1 min-h-0", padded && "p-3.5")}>{children}</div>
    </section>
  );
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Avatar({ name, color, size = 26, className }: { name: string; color?: string | null; size?: number; className?: string }) {
  const parts = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  const ini = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-md font-semibold text-white shrink-0 uppercase", className)}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `linear-gradient(135deg, ${color ?? "#7c5cff"}, color-mix(in oklab, ${color ?? "#7c5cff"} 60%, black))` }}
    >
      {ini}
    </span>
  );
}
