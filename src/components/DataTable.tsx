import { useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/format";

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: number | string;
  align?: "left" | "right" | "center";
  sort?: (a: T, b: T) => number;
  render: (row: T) => ReactNode;
  className?: string;
}

/**
 * Virtualized, sortable table — stays fast with thousands of rows.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowHeight = 30,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  selected,
  initialSort,
  empty,
  className,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  rowHeight?: number;
  onRowClick?: (r: T, e: React.MouseEvent) => void;
  onRowDoubleClick?: (r: T) => void;
  onRowContextMenu?: (r: T, e: React.MouseEvent) => void;
  selected?: Set<string> | string | null;
  initialSort?: { key: string; desc?: boolean };
  empty?: ReactNode;
  className?: string;
  rowClassName?: (r: T) => string | undefined;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const parentRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const s = [...rows].sort(col.sort);
    return sort.desc ? s.reverse() : s;
  }, [rows, sort, columns]);
  const v = useVirtualizer({ count: sorted.length, getScrollElement: () => parentRef.current, estimateSize: () => rowHeight, overscan: 12 });
  const template = columns.map((c) => (typeof c.width === "number" ? `${c.width}px` : c.width ?? "1fr")).join(" ");
  const isSel = (k: string) => (selected instanceof Set ? selected.has(k) : selected === k);

  return (
    <div className={cn("flex flex-col min-h-0 min-w-0 flex-1", className)} role="table">
      <div className="grid items-center h-8 px-2 border-b border-line bg-bg-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3 shrink-0 select-none" style={{ gridTemplateColumns: template }} role="row">
        {columns.map((c) => (
          <button
            key={c.key}
            role="columnheader"
            disabled={!c.sort}
            onClick={() => c.sort && setSort((s) => (s?.key === c.key ? (s.desc ? null : { key: c.key, desc: true }) : { key: c.key }))}
            className={cn("flex items-center gap-1 px-2 truncate h-full", c.align === "right" && "justify-end", c.align === "center" && "justify-center", c.sort && "hover:text-fg-2")}
          >
            {c.header}
            {sort?.key === c.key && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
          </button>
        ))}
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto min-h-0" tabIndex={-1}>
        {sorted.length === 0 ? (
          empty
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((vi) => {
              const r = sorted[vi.index];
              const k = rowKey(r);
              return (
                <div
                  key={k}
                  role="row"
                  aria-selected={isSel(k)}
                  onClick={(e) => onRowClick?.(r, e)}
                  onDoubleClick={() => onRowDoubleClick?.(r)}
                  onContextMenu={(e) => onRowContextMenu?.(r, e)}
                  className={cn(
                    "grid items-center px-2 absolute left-0 right-0 text-[12.5px] border-b border-line/40",
                    isSel(k) ? "bg-accent-soft text-fg" : "hover:bg-bg-3 text-fg-2",
                    rowClassName?.(r),
                  )}
                  style={{ gridTemplateColumns: template, height: vi.size, transform: `translateY(${vi.start}px)` }}
                >
                  {columns.map((c) => (
                    <div key={c.key} role="cell" className={cn("px-2 truncate min-w-0", c.align === "right" && "text-right tabular", c.align === "center" && "text-center", c.className)}>
                      {c.render(r)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
