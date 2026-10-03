import { create } from "zustand";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/format";
import { Kbd } from "./ui";

export type MenuItem =
  | { type?: "item"; label: string; icon?: ReactNode; shortcut?: string; danger?: boolean; disabled?: boolean; onClick?: () => void; children?: MenuItem[]; hint?: string }
  | { type: "separator" }
  | { type: "header"; label: string };

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  show: (x: number, y: number, items: MenuItem[]) => void;
  hide: () => void;
}

export const useContextMenu = create<MenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  hide: () => set({ open: false }),
}));

/** Open a context menu at the mouse position. */
export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  e.stopPropagation?.();
  useContextMenu.getState().show(e.clientX, e.clientY, items.filter(Boolean));
}

/** Open a menu anchored below an element (for "…" buttons). */
export function openMenuAt(el: HTMLElement, items: MenuItem[]) {
  const r = el.getBoundingClientRect();
  useContextMenu.getState().show(r.left, r.bottom + 4, items);
}

function MenuList({ items, x, y, onClose, level = 0 }: { items: MenuItem[]; x: number; y: number; onClose: () => void; level?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ idx: number; x: number; y: number } | null>(null);
  const actionable = items.map((it, i) => ((it.type ?? "item") === "item" && !(it as { disabled?: boolean }).disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + r.width > window.innerWidth - 6) nx = Math.max(6, (level ? x - r.width - 200 : window.innerWidth - r.width - 6));
    if (y + r.height > window.innerHeight - 6) ny = Math.max(6, window.innerHeight - r.height - 6);
    setPos({ x: nx, y: ny });
    if (level === 0) el.focus();
  }, [x, y, level]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const cur = actionable.indexOf(active);
      const next = e.key === "ArrowDown" ? actionable[(cur + 1) % actionable.length] : actionable[(cur - 1 + actionable.length) % actionable.length];
      setActive(next ?? -1);
    } else if (e.key === "Enter" && active >= 0) {
      const it = items[active] as Extract<MenuItem, { label: string; type?: "item" }>;
      if (it.children) return;
      onClose();
      it.onClick?.();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="menu"
      onKeyDown={onKey}
      className="fixed z-[200] min-w-[200px] max-w-[320px] py-1 rounded-lg border border-line-2 bg-bg-2/95 backdrop-blur-md shadow-pop anim-pop outline-none"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.type === "separator") return <div key={i} className="my-1 h-px bg-line" />;
        if (it.type === "header") return <div key={i} className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-fg-4">{it.label}</div>;
        return (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={(e) => {
              setActive(i);
              if (it.children) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSub({ idx: i, x: r.right + 2, y: r.top - 4 });
              } else setSub(null);
            }}
            onClick={() => {
              if (it.children) return;
              onClose();
              it.onClick?.();
            }}
            className={cn(
              "w-[calc(100%-8px)] mx-1 flex items-center gap-2.5 h-7 px-2 rounded-md text-[12.5px] text-left disabled:opacity-40",
              active === i ? (it.danger ? "bg-danger/15 text-danger" : "bg-accent-soft text-fg") : it.danger ? "text-danger" : "text-fg-2",
            )}
          >
            <span className="w-4 flex items-center justify-center shrink-0 opacity-90">{it.icon}</span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.hint && <span className="text-[11px] text-fg-4">{it.hint}</span>}
            {it.shortcut && <Kbd chord={it.shortcut} />}
            {it.children && <ChevronRight size={12} className="text-fg-3" />}
          </button>
        );
      })}
      {sub && (items[sub.idx] as { children?: MenuItem[] }).children && (
        <MenuList items={(items[sub.idx] as { children: MenuItem[] }).children} x={sub.x} y={sub.y} onClose={onClose} level={level + 1} />
      )}
    </div>
  );
}

export function ContextMenuHost() {
  const { open, x, y, items, hide } = useContextMenu();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.closest?.("[role=menu]")) return;
      hide();
    };
    const onBlur = () => hide();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [open, hide]);
  if (!open) return null;
  return createPortal(<MenuList items={items} x={x} y={y} onClose={hide} />, document.body);
}
