import { useCallback, useRef, type ReactNode } from "react";
import { cn } from "@/lib/format";

/** Draggable divider; reports a delta in px. */
export function Resizer({ dir, onDrag, onEnd, className }: { dir: "row" | "column"; onDrag: (delta: number) => void; onEnd?: () => void; className?: string }) {
  const start = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    start.current = dir === "row" ? e.clientX : e.clientY;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = dir === "row" ? "col-resize" : "row-resize";
    const move = (ev: PointerEvent) => {
      const p = dir === "row" ? ev.clientX : ev.clientY;
      onDrag(p - start.current);
      start.current = p;
    };
    const up = () => {
      document.body.style.cursor = "";
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onEnd?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation={dir === "row" ? "vertical" : "horizontal"}
      onPointerDown={onDown}
      className={cn(
        "relative shrink-0 z-10 group",
        dir === "row" ? "w-px cursor-col-resize bg-line" : "h-px cursor-row-resize bg-line",
        className,
      )}
    >
      <div className={cn("absolute transition-colors group-hover:bg-accent/60 group-active:bg-accent", dir === "row" ? "inset-y-0 -left-[2px] -right-[2px]" : "inset-x-0 -top-[2px] -bottom-[2px]")} />
    </div>
  );
}

/** N-way split with percentage sizes. */
export function SplitView({ dir, sizes, onSizes, children, minPct = 8 }: { dir: "row" | "column"; sizes: number[]; onSizes: (s: number[], done: boolean) => void; children: ReactNode[]; minPct?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const cur = useRef(sizes);
  cur.current = sizes;
  const drag = useCallback(
    (i: number, delta: number) => {
      const el = ref.current;
      if (!el) return;
      const total = dir === "row" ? el.clientWidth : el.clientHeight;
      const d = (delta / total) * 100;
      const s = [...cur.current];
      let a = s[i] + d;
      let b = s[i + 1] - d;
      if (a < minPct) {
        b -= minPct - a;
        a = minPct;
      }
      if (b < minPct) {
        a -= minPct - b;
        b = minPct;
      }
      s[i] = a;
      s[i + 1] = b;
      cur.current = s;
      onSizes(s, false);
    },
    [dir, minPct, onSizes],
  );
  return (
    <div ref={ref} className={cn("flex w-full h-full min-w-0 min-h-0", dir === "row" ? "flex-row" : "flex-col")}>
      {children.map((c, i) => (
        <div key={i} className="contents">
          <div className="min-w-0 min-h-0 flex relative" style={{ flexBasis: `${sizes[i]}%`, flexGrow: 0, flexShrink: 1 }}>
            {c}
          </div>
          {i < children.length - 1 && <Resizer dir={dir} onDrag={(d) => drag(i, d)} onEnd={() => onSizes(cur.current, true)} />}
        </div>
      ))}
    </div>
  );
}
