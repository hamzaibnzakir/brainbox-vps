import { basename, extension } from "./paths";

/** Map a filename to a Monaco language id. */
export function languageFor(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name.startsWith(".env") || name.endsWith(".env")) return "dotenv";
  if (name === "nginx.conf" || path.includes("/nginx/") || name.endsWith(".nginx")) return "nginx";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile", ".bash_aliases"].includes(name)) return "shell";
  if (name === "docker-compose.yml" || name === "compose.yml" || name === "compose.yaml") return "yaml";
  if (name === "caddyfile") return "nginx";
  if (name === "crontab") return "shell";
  if (name.endsWith(".service") || name.endsWith(".timer") || name.endsWith(".socket")) return "ini";
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "typescript",
    py: "python",
    rs: "rust",
    go: "go",
    php: "php",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    jsonc: "json",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    sql: "sql",
    toml: "ini",
    ini: "ini",
    conf: "ini",
    cfg: "ini",
    xml: "xml",
    svg: "xml",
    java: "java",
    rb: "ruby",
    lua: "lua",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    kt: "kotlin",
    swift: "swift",
    vue: "html",
    graphql: "graphql",
    ps1: "powershell",
    bat: "bat",
    log: "log",
  };
  return map[extension(name)] ?? "plaintext";
}

const TEXT_EXT = new Set([
  "txt", "md", "json", "yml", "yaml", "toml", "ini", "conf", "cfg", "env", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go", "php",
  "html", "htm", "css", "scss", "less", "sh", "bash", "zsh", "sql", "xml", "svg", "log", "csv", "service", "timer", "lock", "gitignore",
  "dockerignore", "editorconfig", "rb", "lua", "c", "h", "cpp", "java", "kt", "vue", "graphql", "ps1", "bat", "properties", "pem", "pub",
]);

const BINARY_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "pdf", "zip", "gz", "tgz", "xz", "bz2", "7z", "rar", "tar", "mp3", "mp4", "mov", "avi", "woff", "woff2", "ttf", "otf", "exe", "dll", "so", "bin", "iso", "db", "sqlite", "jar", "class", "o", "a", "deb", "rpm"]);

/** Heuristic: should double-click open the editor (vs download)? */
export function isProbablyText(name: string, size: number): boolean {
  const ext = extension(name);
  if (BINARY_EXT.has(ext)) return false;
  if (TEXT_EXT.has(ext)) return true;
  if (!ext || name.startsWith(".")) return size < 2 * 1024 * 1024;
  return size < 512 * 1024;
}
