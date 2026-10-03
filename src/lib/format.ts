export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

/** "97 / 160 GB" — used/total sharing the total's unit, compact enough for stat cards. */
export function formatBytesPair(used: number | null | undefined, total: number | null | undefined): string {
  if (used == null || total == null || !isFinite(used) || !isFinite(total)) return "—";
  if (total < 1024) return `${Math.round(used)} / ${Math.round(total)} B`;
  let i = 0;
  let t = total;
  while (t >= 1024 && i < UNITS.length - 1) {
    t /= 1024;
    i++;
  }
  const u = used / Math.pow(1024, i);
  const fmt = (v: number) => (v >= 10 || v === 0 ? Math.round(v).toString() : v.toFixed(1));
  return `${fmt(u)} / ${fmt(t)} ${UNITS[i]}`;
}

export function formatRate(bps: number | null | undefined): string {
  if (bps == null || !isFinite(bps) || bps <= 0) return "0 B/s";
  return `${formatBytes(bps)}/s`;
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || !isFinite(secs)) return "—";
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v == null || !isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function relativeTime(unixSecs: number | null | undefined): string {
  if (!unixSecs) return "never";
  const diff = Date.now() / 1000 - unixSecs;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString();
}

export function formatDate(unixSecs: number | null | undefined): string {
  if (!unixSecs) return "—";
  const d = new Date(unixSecs * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { year: sameYear ? undefined : "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** rwxr-xr-x from a mode number. */
export function permString(mode: number | null | undefined, isDir = false): string {
  if (mode == null) return "—";
  const chars = ["r", "w", "x"];
  let s = isDir ? "d" : "-";
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? chars[(8 - i) % 3] : "-";
  return s;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Deterministic pleasant color for a string. */
export function colorFor(s: string): string {
  const palette = ["#7c5cff", "#22c55e", "#f59e0b", "#06b6d4", "#ec4899", "#3b82f6", "#ef4444", "#14b8a6", "#a855f7", "#eab308"];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
