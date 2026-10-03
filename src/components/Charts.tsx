import { useId, useMemo } from "react";
import { cn } from "@/lib/format";

/** Tiny inline sparkline (SVG). */
export function Sparkline({ values, max = 100, color = "var(--accent)", width = 60, height = 18, className }: { values: number[]; max?: number; color?: string; width?: number; height?: number; className?: string }) {
  const id = useId();
  const d = useMemo(() => {
    if (values.length < 2) return "";
    const step = width / (values.length - 1);
    return values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(height - (Math.min(v, max) / max) * (height - 2) - 1).toFixed(1)}`).join(" ");
  }, [values, max, width, height]);
  if (!d) return <svg width={width} height={height} className={className} />;
  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export interface Series {
  values: number[];
  color: string;
  label: string;
}

/** Responsive area chart for the dashboard (SVG, no dependencies). */
export function AreaChart({ series, max, height = 140, className, format = (v) => v.toFixed(0), gridLines = 4, points = 90 }: { series: Series[]; max?: number; height?: number; className?: string; format?: (v: number) => string; gridLines?: number; points?: number }) {
  const uid = useId();
  const W = 600;
  const H = height;
  const top = Math.max(1, max ?? Math.max(1, ...series.flatMap((s) => s.values)) * 1.15);
  const paths = useMemo(
    () =>
      series.map((s) => {
        const vals = s.values.slice(-points);
        const n = Math.max(points, vals.length);
        const offset = n - vals.length;
        const step = W / (n - 1);
        const pts = vals.map((v, i) => [((i + offset) * step), H - (Math.min(v, top) / top) * (H - 6) - 3] as const);
        if (pts.length < 2) return { line: "", area: "" };
        // Smooth with a simple monotone-ish curve.
        let line = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1];
          const [x1, y1] = pts[i];
          const cx = (x0 + x1) / 2;
          line += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
        }
        const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
        return { line, area };
      }),
    [series, top, H, points],
  );
  return (
    <div className={cn("relative w-full", className)} style={{ height: H }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={i} id={`${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="1" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>
        {Array.from({ length: gridLines }, (_, i) => (
          <line key={i} x1="0" x2={W} y1={(H / gridLines) * i + 0.5} y2={(H / gridLines) * i + 0.5} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 4" />
        ))}
        {paths.map((p, i) => (
          <g key={i}>
            <path d={p.area} fill={`url(#${uid}-${i})`} />
            <path d={p.line} fill="none" stroke={series[i].color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        ))}
      </svg>
      <div className="absolute top-0 right-0 text-[10px] text-fg-4 tabular pointer-events-none -translate-y-full pb-0.5">{format(top)}</div>
    </div>
  );
}

/** Ring gauge for percentages. */
export function Ring({ value, size = 64, stroke = 6, color = "var(--accent)", children }: { value: number; size?: number; stroke?: number; color?: string; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--bg-4)" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ transition: "stroke-dashoffset 600ms var(--ease-out)" }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}
