/** Path helpers for remote POSIX paths and local (Windows or POSIX) paths. */

export function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]?/.test(p) || p.includes("\\");
}

export function sepOf(p: string): string {
  return isWindowsPath(p) ? "\\" : "/";
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const sep = sepOf(p);
  const t = p.endsWith(sep) && p.length > 1 ? p.slice(0, -1) : p;
  const i = t.lastIndexOf(sep);
  if (i < 0) return "";
  if (sep === "/" && i === 0) return "/";
  if (sep === "\\" && i === 2) return t.slice(0, 3);
  return t.slice(0, i);
}

/** Split a path into clickable breadcrumb segments. */
export function breadcrumbs(p: string): Array<{ name: string; path: string }> {
  if (!p) return [];
  if (isWindowsPath(p)) {
    const parts = p.split("\\").filter(Boolean);
    const out: Array<{ name: string; path: string }> = [];
    let acc = "";
    parts.forEach((part, i) => {
      acc = i === 0 ? `${part}\\` : joinPath(acc, part);
      out.push({ name: part, path: acc });
    });
    return out;
  }
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of p.split("/").filter(Boolean)) {
    acc += "/" + part;
    out.push({ name: part, path: acc });
  }
  return out;
}

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Make a remote file name safe on Windows (mirrors the Rust sanitizer). */
export function windowsSafeName(name: string): string {
  let s = name.replace(/[<>:"\\|?*\x00-\x1f]/g, "_");
  s = s.replace(/[. ]+$/, (m) => "_".repeat(m.length));
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = "_" + s;
  return s || "_";
}
