/* Seed data and defaults for the mock backend. */
import type * as T from "@/types/generated";

export function defaultSettings(): T.Settings {
  return {
    theme: "dark",
    accent: "#7c5cff",
    density: "comfortable",
    uiFontSize: 13,
    terminalFontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    terminalFontSize: 14,
    terminalLineHeight: 1.2,
    terminalScrollback: 10000,
    terminalCursorStyle: "bar",
    terminalCursorBlink: true,
    copyOnSelect: false,
    rightClickPaste: true,
    confirmMultilinePaste: true,
    monitorIntervalMs: 2000,
    backgroundMonitorIntervalMs: 15000,
    defaultUseTmux: false,
    showHiddenFiles: false,
    transferConcurrency: 3,
    confirmDangerousCommands: true,
    closeToTray: false,
    launchAtStartup: false,
    checkUpdates: true,
    restoreWorkspace: true,
    editorMinimap: true,
    editorWordWrap: false,
    editorFontSize: 14,
    notifications: {
      enabled: true,
      sshDisconnected: true,
      sshReconnected: true,
      transferFinished: true,
      containerStopped: true,
      serverUnreachable: true,
      commandFinished: true,
      minDurationSecs: 10,
    },
    ai: {
      enabled: false,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-5-5",
      hasApiKey: false,
      autoRunReadOnly: true,
    },
  };
}

const now = () => Math.floor(Date.now() / 1000);

function server(id: string, name: string, host: string, extra: Partial<T.ServerProfile> = {}): T.ServerProfile {
  return {
    id,
    name,
    host,
    port: 22,
    username: "deploy",
    authMethod: "key",
    keyPath: "C:\\Users\\David\\.ssh\\id_ed25519",
    hasPassword: false,
    hasPassphrase: false,
    hasKeyData: false,
    group: "Production",
    tags: [],
    favorite: false,
    color: null,
    notes: null,
    proxy: null,
    jumpHostId: null,
    keepaliveSecs: 30,
    connectTimeoutSecs: 15,
    autoReconnect: true,
    useTmux: false,
    startupDir: null,
    startupCommand: null,
    sortOrder: 0,
    createdAt: now() - 86400 * 30,
    updatedAt: now() - 3600,
    lastConnectedAt: now() - 7200,
    ...extra,
  };
}

export function seedServers(): T.ServerProfile[] {
  return [
    server("srv-prod", "Production VPS", "203.0.113.10", { favorite: true, tags: ["shopify", "web"], color: "#7c5cff", sortOrder: 0 }),
    server("srv-db", "Database VPS", "203.0.113.20", { tags: ["postgres"], color: "#22c55e", sortOrder: 1 }),
    server("srv-dev", "Development VPS", "198.51.100.7", { group: "Development", username: "david", authMethod: "password", hasPassword: true, keyPath: null, tags: ["staging"], color: "#f59e0b", sortOrder: 2 }),
    server("srv-edge", "Edge Proxy", "edge.brainbox.dev", { group: "Development", authMethod: "password", hasPassword: false, keyPath: null, username: "root", sortOrder: 3 }),
    server("srv-old", "Legacy Box", "192.0.2.99", { group: "Archive", port: 2222, sortOrder: 4, lastConnectedAt: null }),
  ];
}

export interface MockNode {
  kind: "file" | "dir" | "symlink";
  content?: string;
  size?: number;
  mtime: number;
  mode: number;
  owner?: string;
}

export function seedRemoteFs(user: string): Map<string, MockNode> {
  const m = new Map<string, MockNode>();
  const t = now();
  const dir = (p: string, owner = "root") => m.set(p, { kind: "dir", mtime: t - 5000, mode: 0o755, owner });
  const file = (p: string, content: string, owner = "root", mode = 0o644) => m.set(p, { kind: "file", content, size: content.length, mtime: t - Math.floor(Math.random() * 90000), mode, owner });
  for (const d of ["/", "/etc", "/etc/nginx", "/etc/nginx/sites-enabled", "/var", "/var/log", "/var/log/nginx", "/var/www", "/opt", "/srv", "/tmp", "/home"]) dir(d);
  dir(`/home/${user}`, user);
  dir(`/home/${user}/.ssh`, user);
  dir("/var/www/shop", user);
  dir("/var/www/shop/src", user);
  dir("/var/www/shop/public", user);
  file(
    "/etc/nginx/nginx.conf",
    `user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n    worker_connections 1024;\n}\n\nhttp {\n    sendfile on;\n    tcp_nopush on;\n    keepalive_timeout 65;\n    include /etc/nginx/mime.types;\n    default_type application/octet-stream;\n\n    gzip on;\n    include /etc/nginx/sites-enabled/*;\n}\n`,
  );
  file(
    "/etc/nginx/sites-enabled/shop.conf",
    `server {\n    listen 80;\n    server_name shop.example.com;\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n    }\n}\n`,
  );
  file("/var/log/nginx/access.log", Array.from({ length: 40 }, (_, i) => `203.0.113.${i % 250} - - [03/Oct/2026:12:${String(i % 60).padStart(2, "0")}:01 +0000] "GET /products/${i} HTTP/1.1" 200 ${1200 + i * 13} "-" "Mozilla/5.0"`).join("\n") + "\n");
  file("/var/log/syslog", "Oct  3 12:00:01 prod systemd[1]: Started Daily apt download activities.\n");
  file(`/home/${user}/.bashrc`, "# ~/.bashrc\nexport PATH=$HOME/.local/bin:$PATH\nalias ll='ls -alF'\n", user);
  file(`/home/${user}/deploy.sh`, "#!/usr/bin/env bash\nset -euo pipefail\ncd /var/www/shop\ngit pull --ff-only\nnpm ci\nnpm run build\npm2 restart shop\n", user, 0o755);
  file(`/home/${user}/.ssh/authorized_keys`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... david@laptop\n", user, 0o600);
  file("/var/www/shop/package.json", `{\n  "name": "shop",\n  "version": "2.4.1",\n  "scripts": {\n    "build": "next build",\n    "start": "next start -p 3000"\n  }\n}\n`, user);
  file("/var/www/shop/.env", "DATABASE_URL=postgres://shop:secret@10.0.0.20/shop\nSTRIPE_KEY=sk_live_xxx\n", user, 0o600);
  file("/var/www/shop/docker-compose.yml", "services:\n  web:\n    build: .\n    ports:\n      - \"3000:3000\"\n  redis:\n    image: redis:7-alpine\n", user);
  file("/var/www/shop/src/server.ts", `import express from "express";\n\nconst app = express();\n\napp.get("/health", (_req, res) => res.json({ ok: true }));\n\napp.listen(3000, () => console.log("listening on :3000"));\n`, user);
  file("/var/www/shop/README.md", "# Shop\n\nProduction storefront.\n\n- `npm run build`\n- `pm2 restart shop`\n", user);
  file("/var/www/shop/public/robots.txt", "User-agent: *\nAllow: /\n", user);
  return m;
}

export function seedLocalFs(): Map<string, MockNode> {
  const m = new Map<string, MockNode>();
  const t = now();
  const dir = (p: string) => m.set(p, { kind: "dir", mtime: t - 9000, mode: 0o755 });
  const file = (p: string, size: number) => m.set(p, { kind: "file", content: "x".repeat(Math.min(size, 64)), size, mtime: t - Math.floor(Math.random() * 500000), mode: 0o644 });
  for (const d of ["C:\\", "C:\\Users", "C:\\Users\\David", "C:\\Users\\David\\Desktop", "C:\\Users\\David\\Documents", "C:\\Users\\David\\Downloads", "C:\\Users\\David\\Projects", "C:\\Users\\David\\Projects\\shop", "C:\\Users\\David\\.ssh"]) dir(d);
  file("C:\\Users\\David\\Downloads\\backup-2026-10-01.tar.gz", 248_331_002);
  file("C:\\Users\\David\\Downloads\\invoice.pdf", 92_114);
  file("C:\\Users\\David\\Documents\\notes.md", 4_211);
  file("C:\\Users\\David\\Projects\\shop\\package.json", 812);
  file("C:\\Users\\David\\Projects\\shop\\README.md", 1_204);
  file("C:\\Users\\David\\Desktop\\logo.png", 48_120);
  file("C:\\Users\\David\\.ssh\\id_ed25519", 411);
  file("C:\\Users\\David\\.ssh\\id_ed25519.pub", 98);
  return m;
}

export const PROCESSES: T.ProcessInfo[] = [
  { pid: 1, ppid: 0, user: "root", state: "Ss", cpuPercent: 0.0, memPercent: 0.3, rssKb: 12800, elapsedSecs: 1_204_800, name: "systemd", command: "/sbin/init" },
  { pid: 612, ppid: 1, user: "root", state: "Ss", cpuPercent: 0.0, memPercent: 0.2, rssKb: 8100, elapsedSecs: 1_204_700, name: "sshd", command: "sshd: /usr/sbin/sshd -D [listener]" },
  { pid: 811, ppid: 1, user: "root", state: "Ss", cpuPercent: 0.1, memPercent: 0.4, rssKb: 15200, elapsedSecs: 1_204_600, name: "nginx", command: "nginx: master process /usr/sbin/nginx" },
  { pid: 812, ppid: 811, user: "www-data", state: "S", cpuPercent: 2.4, memPercent: 0.6, rssKb: 22100, elapsedSecs: 1_204_600, name: "nginx", command: "nginx: worker process" },
  { pid: 1022, ppid: 1, user: "deploy", state: "Sl", cpuPercent: 18.7, memPercent: 9.8, rssKb: 402_000, elapsedSecs: 86_000, name: "node", command: "node /var/www/shop/.next/standalone/server.js" },
  { pid: 1120, ppid: 1, user: "postgres", state: "Ss", cpuPercent: 4.2, memPercent: 6.1, rssKb: 251_000, elapsedSecs: 1_204_000, name: "postgres", command: "/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main" },
  { pid: 1301, ppid: 1, user: "root", state: "Ssl", cpuPercent: 1.1, memPercent: 2.0, rssKb: 81_000, elapsedSecs: 1_203_000, name: "dockerd", command: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock" },
  { pid: 1402, ppid: 1, user: "redis", state: "Ssl", cpuPercent: 0.4, memPercent: 0.9, rssKb: 36_000, elapsedSecs: 1_203_000, name: "redis-server", command: "/usr/bin/redis-server 127.0.0.1:6379" },
  { pid: 2210, ppid: 1, user: "deploy", state: "Sl", cpuPercent: 0.7, memPercent: 1.4, rssKb: 58_000, elapsedSecs: 86_100, name: "PM2 v5.3.0: God", command: "PM2 v5.3.0: God Daemon (/home/deploy/.pm2)" },
  { pid: 3301, ppid: 1, user: "root", state: "Ss", cpuPercent: 0.0, memPercent: 0.1, rssKb: 3200, elapsedSecs: 1_200_000, name: "cron", command: "/usr/sbin/cron -f -P" },
];

export const PORTS: T.PortInfo[] = [
  { protocol: "tcp", localAddress: "0.0.0.0", port: 22, state: "LISTEN", process: "sshd", pid: 612 },
  { protocol: "tcp", localAddress: "0.0.0.0", port: 80, state: "LISTEN", process: "nginx", pid: 811 },
  { protocol: "tcp", localAddress: "0.0.0.0", port: 443, state: "LISTEN", process: "nginx", pid: 811 },
  { protocol: "tcp", localAddress: "127.0.0.1", port: 3000, state: "LISTEN", process: "node", pid: 1022 },
  { protocol: "tcp", localAddress: "127.0.0.1", port: 5432, state: "LISTEN", process: "postgres", pid: 1120 },
  { protocol: "tcp", localAddress: "127.0.0.1", port: 6379, state: "LISTEN", process: "redis-server", pid: 1402 },
  { protocol: "udp", localAddress: "127.0.0.53", port: 53, state: "UNCONN", process: "systemd-resolve", pid: 540 },
];

export const SERVICES: T.ServiceInfo[] = [
  { name: "cron.service", description: "Regular background program processing daemon", loadState: "loaded", activeState: "active", subState: "running", enabledState: "enabled" },
  { name: "docker.service", description: "Docker Application Container Engine", loadState: "loaded", activeState: "active", subState: "running", enabledState: "enabled" },
  { name: "fail2ban.service", description: "Fail2Ban Service", loadState: "loaded", activeState: "failed", subState: "failed", enabledState: "enabled" },
  { name: "nginx.service", description: "A high performance web server and a reverse proxy server", loadState: "loaded", activeState: "active", subState: "running", enabledState: "enabled" },
  { name: "postgresql.service", description: "PostgreSQL RDBMS", loadState: "loaded", activeState: "active", subState: "exited", enabledState: "enabled" },
  { name: "redis-server.service", description: "Advanced key-value store", loadState: "loaded", activeState: "active", subState: "running", enabledState: "enabled" },
  { name: "ssh.service", description: "OpenBSD Secure Shell server", loadState: "loaded", activeState: "active", subState: "running", enabledState: "enabled" },
  { name: "ufw.service", description: "Uncomplicated firewall", loadState: "loaded", activeState: "active", subState: "exited", enabledState: "enabled" },
  { name: "apache2.service", description: "", loadState: "not-loaded", activeState: "inactive", subState: "dead", enabledState: "disabled" },
];

export function seedContainers(): T.DockerContainer[] {
  return [
    { id: "a1b2c3d4e5f6", name: "shop-web-1", image: "shop-web:2.4.1", state: "running", status: "Up 3 days", ports: "0.0.0.0:3000->3000/tcp", created: "2026-09-30 10:12:00 +0000 UTC", composeProject: "shop" },
    { id: "b2c3d4e5f6a1", name: "shop-redis-1", image: "redis:7-alpine", state: "running", status: "Up 3 days", ports: "6379/tcp", created: "2026-09-30 10:12:00 +0000 UTC", composeProject: "shop" },
    { id: "c3d4e5f6a1b2", name: "shop-worker-1", image: "shop-web:2.4.1", state: "running", status: "Up 3 days", ports: "", created: "2026-09-30 10:12:01 +0000 UTC", composeProject: "shop" },
    { id: "d4e5f6a1b2c3", name: "uptime-kuma", image: "louislam/uptime-kuma:1", state: "exited", status: "Exited (0) 2 days ago", ports: "", created: "2026-08-12 08:00:00 +0000 UTC", composeProject: null },
  ];
}

export const IMAGES: T.DockerImage[] = [
  { id: "sha256:9a1f", repository: "shop-web", tag: "2.4.1", size: "412MB", created: "3 days ago" },
  { id: "sha256:7c2e", repository: "redis", tag: "7-alpine", size: "41MB", created: "3 weeks ago" },
  { id: "sha256:1d8b", repository: "louislam/uptime-kuma", tag: "1", size: "386MB", created: "2 months ago" },
];

export const GIT_LOG: T.GitCommit[] = [
  { hash: "9f2c1e7a4b0d", author: "David", email: "david@brainbox.dev", timestamp: now() - 3600 * 5, subject: "feat(checkout): add Paystack payment option" },
  { hash: "4a8d2b6c1e9f", author: "David", email: "david@brainbox.dev", timestamp: now() - 86400, subject: "fix: product images on mobile" },
  { hash: "7b3e9d1f0a2c", author: "Ada", email: "ada@brainbox.dev", timestamp: now() - 86400 * 2, subject: "chore: bump next to 15.3" },
  { hash: "1c5f7a9e3b4d", author: "David", email: "david@brainbox.dev", timestamp: now() - 86400 * 4, subject: "Initial storefront" },
];
