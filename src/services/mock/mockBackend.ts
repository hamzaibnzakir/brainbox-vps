/**
 * In-memory backend used when Brainbox runs in a plain browser (no Tauri):
 * UI development, Playwright E2E tests and screenshots. It simulates servers,
 * connections (incl. host-key prompts and failures), a shell, file trees,
 * transfers, metrics, Docker, Git, logs, tunnels and the AI assistant.
 */
import type { Backend } from "../backend";
import type * as T from "@/types/generated";
import { defaultSettings, GIT_LOG, IMAGES, PORTS, PROCESSES, SERVICES, seedContainers, seedLocalFs, seedRemoteFs, seedServers, type MockNode } from "./data";
import { MockShell } from "./shell";

type Handler = (args: Record<string, any>) => unknown | Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const uid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

function err(code: T.ErrorCode, title: string, message: string, causes: string[] = [], details: string | null = null): T.AppError {
  return { code, title, message, causes, details };
}

class MockChannel<M> {
  constructor(public onmessage: (m: M) => void) {}
}

export function createMockBackend(): Backend {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  const empty = params.has("empty");
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((cb) => cb(payload));

  let servers: T.ServerProfile[] = empty ? [] : seedServers();
  let settings = defaultSettings();
  const statuses = new Map<string, T.ConnectionStatus>();
  const trusted = new Set<string>(empty ? [] : ["srv-prod:22", "srv-db:22"]);
  const pendingKeys = new Map<string, { prompt: T.HostKeyPrompt; resolve: (d: T.HostKeyDecision) => void }>();
  const fsByServer = new Map<string, Map<string, MockNode>>();
  const localFs = seedLocalFs();
  const shells = new Map<string, MockShell>();
  const monitors = new Map<string, { timer: ReturnType<typeof setInterval>; history: T.MetricsSnapshot[]; cpu: number; mem: number }>();
  const transfers = new Map<string, { info: T.TransferInfo; timer?: ReturnType<typeof setInterval> }>();
  let tunnels: T.TunnelConfig[] = empty
    ? []
    : [
        { id: "tun-db", serverId: "srv-db", name: "Postgres", kind: "local", bindHost: "127.0.0.1", bindPort: 5433, targetHost: "127.0.0.1", targetPort: 5432, autoStart: true },
        { id: "tun-socks", serverId: "srv-prod", name: "SOCKS proxy", kind: "dynamic", bindHost: "127.0.0.1", bindPort: 1080, targetHost: "", targetPort: 0, autoStart: false },
      ];
  const tunnelStatus = new Map<string, T.TunnelStatus>();
  let snippets: T.Snippet[] = empty
    ? []
    : [
        { id: "sn1", name: "Build", description: "Production build", command: "npm run build", category: "Deploy", serverId: null, shortcut: null, createdAt: now(), updatedAt: now() },
        { id: "sn2", name: "Compose up", description: "Start the stack", command: "docker compose up -d", category: "Docker", serverId: null, shortcut: "Ctrl+Alt+1", createdAt: now(), updatedAt: now() },
        { id: "sn3", name: "Follow compose logs", description: null, command: "docker compose logs -f", category: "Docker", serverId: null, shortcut: null, createdAt: now(), updatedAt: now() },
        { id: "sn4", name: "Restart PM2", description: null, command: "pm2 restart all", category: "Deploy", serverId: "srv-prod", shortcut: null, createdAt: now(), updatedAt: now() },
        { id: "sn5", name: "Pull latest", description: null, command: "git pull", category: "Git", serverId: null, shortcut: null, createdAt: now(), updatedAt: now() },
        { id: "sn6", name: "Reload nginx", description: "Test config then reload", command: "sudo nginx -t && sudo systemctl reload nginx", category: "Web", serverId: null, shortcut: null, createdAt: now(), updatedAt: now() },
      ];
  let workspaces: T.Workspace[] = empty
    ? []
    : [{ id: "ws-shopify", name: "Shopify Infrastructure", icon: null, serverIds: ["srv-prod", "srv-dev", "srv-db"], layout: {}, createdAt: now(), updatedAt: now() }];
  const kv = new Map<string, string>();
  let knownHosts: T.KnownHost[] = [
    { host: "203.0.113.10", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:k2F9cQx0bV7m1nJ8pL3sR6tW4yZ5aB2cD7eF0gH1iJ8", addedAt: now() - 86400 * 20 },
  ];
  const containersByServer = new Map<string, T.DockerContainer[]>();
  const services = new Map<string, T.ServiceInfo[]>();
  const chats = new Map<string, { serverId: string; items: T.AiChatItem[]; pending: T.AiProposal | null; step: number }>();

  const fsFor = (sid: string) => {
    if (!fsByServer.has(sid)) {
      const s = servers.find((x) => x.id === sid);
      fsByServer.set(sid, seedRemoteFs(s?.username ?? "deploy"));
    }
    return fsByServer.get(sid)!;
  };
  const server = (id: string) => {
    const s = servers.find((x) => x.id === id);
    if (!s) throw err("not_found", "Server not found", "This server no longer exists.");
    return s;
  };
  const status = (id: string): T.ConnectionStatus => statuses.get(id) ?? { serverId: id, state: { state: "disconnected" }, latencyMs: null, fingerprint: null, serverBanner: null };
  const setStatus = (id: string, state: T.ConnectionState, extra: Partial<T.ConnectionStatus> = {}) => {
    const s = { ...status(id), ...extra, state };
    statuses.set(id, s);
    emit("connection://status", s);
    return s;
  };
  const requireConn = (id: string) => {
    if (status(id).state.state !== "connected") throw err("not_connected", "Not connected", "This server is not connected. Connect to it first.");
  };

  const parent = (p: string) => {
    if (p === "/") return null;
    const t = p.replace(/\/+$/, "");
    const i = t.lastIndexOf("/");
    return i <= 0 ? "/" : t.slice(0, i);
  };
  const join = (d: string, n: string) => (d.endsWith("/") ? d + n : `${d}/${n}`);
  const lparent = (p: string) => {
    const t = p.replace(/\\+$/, "");
    const i = t.lastIndexOf("\\");
    if (i < 0) return "";
    return i === 2 ? t.slice(0, 3) : t.slice(0, i);
  };
  const ljoin = (d: string, n: string) => (d.endsWith("\\") ? d + n : `${d}\\${n}`);

  const entry = (path: string, n: MockNode, sep = "/"): T.FileEntry => {
    const name = path === "/" ? "/" : path.split(sep).filter(Boolean).pop() ?? path;
    return {
      name,
      path,
      kind: n.kind,
      linkIsDir: false,
      size: n.kind === "dir" ? 4096 : n.size ?? (n.content?.length ?? 0),
      modified: n.mtime,
      permissions: n.mode,
      owner: n.owner ?? null,
      group: n.owner ?? null,
      hidden: name.startsWith("."),
    };
  };
  const sortEntries = (e: T.FileEntry[]) =>
    e.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const children = (fs: Map<string, MockNode>, dir: string, sep: string) => {
    const out: T.FileEntry[] = [];
    for (const [p, n] of fs) {
      if (p === dir) continue;
      const par = sep === "/" ? parent(p) : lparent(p);
      if (par === dir) out.push(entry(p, n, sep));
    }
    return sortEntries(out);
  };

  function startMonitor(sid: string, intervalMs: number) {
    const ex = monitors.get(sid);
    if (ex) clearInterval(ex.timer);
    const m = ex ?? { timer: 0 as unknown as ReturnType<typeof setInterval>, history: [], cpu: 20 + Math.random() * 20, mem: 0.45 };
    const tick = () => {
      if (status(sid).state.state !== "connected") return;
      m.cpu = Math.max(2, Math.min(97, m.cpu + (Math.random() - 0.5) * 14));
      m.mem = Math.max(0.2, Math.min(0.92, m.mem + (Math.random() - 0.5) * 0.02));
      const total = sid === "srv-db" ? 16 * 2 ** 30 : 8 * 2 ** 30;
      const snap: T.MetricsSnapshot = {
        serverId: sid,
        timestamp: Date.now(),
        cpuPercent: m.cpu,
        cpuCores: sid === "srv-db" ? 8 : 4,
        memTotal: total,
        memUsed: Math.round(total * m.mem),
        memAvailable: Math.round(total * (1 - m.mem)),
        memCached: Math.round(total * 0.18),
        swapTotal: 2 * 2 ** 30,
        swapUsed: Math.round(2 ** 28 * (1 + Math.random() * 0.1)),
        load1: (m.cpu / 100) * 4,
        load5: (m.cpu / 100) * 3.4,
        load15: (m.cpu / 100) * 3,
        uptimeSecs: 1_204_800 + Math.floor(Date.now() / 1000) % 100000,
        netRxBps: 200_000 + Math.random() * 2_400_000,
        netTxBps: 80_000 + Math.random() * 900_000,
        netRxTotal: 1e12,
        netTxTotal: 4e11,
        disks: [
          { filesystem: "/dev/vda1", fsType: "ext4", mount: "/", totalBytes: 160 * 2 ** 30, usedBytes: 97 * 2 ** 30, availBytes: 63 * 2 ** 30 },
          { filesystem: "/dev/vdb1", fsType: "xfs", mount: "/mnt/backups", totalBytes: 500 * 2 ** 30, usedBytes: 412 * 2 ** 30, availBytes: 88 * 2 ** 30 },
        ],
        processCount: 184 + Math.floor(Math.random() * 6),
        listeningPorts: 7,
        latencyMs: 30 + Math.floor(Math.random() * 25),
      };
      m.history.push(snap);
      if (m.history.length > 600) m.history.shift();
      emit("monitor://metrics", snap);
    };
    // Backfill some history so charts look alive immediately.
    if (m.history.length === 0) for (let i = 0; i < 40; i++) tick();
    m.timer = setInterval(tick, Math.max(300, intervalMs));
    monitors.set(sid, m);
  }

  function runTransfer(id: string) {
    const t = transfers.get(id);
    if (!t) return;
    t.info.state = "running";
    t.info.startedAt ??= now();
    emit("transfer://update", { ...t.info });
    t.timer = setInterval(() => {
      const step = Math.min(t.info.totalBytes - t.info.transferredBytes, 3_500_000 + Math.random() * 2_000_000);
      t.info.transferredBytes += step;
      t.info.speedBps = step * 4;
      t.info.etaSecs = Math.ceil((t.info.totalBytes - t.info.transferredBytes) / Math.max(1, t.info.speedBps));
      if (t.info.transferredBytes >= t.info.totalBytes) {
        clearInterval(t.timer);
        t.info.state = "completed";
        t.info.filesDone = t.info.filesTotal;
        t.info.finishedAt = now();
        t.info.speedBps = 0;
        t.info.etaSecs = null;
        if (t.info.direction === "upload") {
          const fs = fsFor(t.info.serverId);
          fs.set(t.info.remotePath, { kind: "file", size: t.info.totalBytes, content: localFs.get(t.info.localPath)?.content ?? "", mtime: now(), mode: 0o644, owner: "deploy" });
        } else {
          localFs.set(t.info.localPath, { kind: "file", size: t.info.totalBytes, content: fsFor(t.info.serverId).get(t.info.remotePath)?.content, mtime: now(), mode: 0o644 });
        }
      }
      emit("transfer://update", { ...t.info });
    }, 250);
  }

  const h: Record<string, Handler> = {
    // ───── servers
    servers_list: () => [...servers].sort((a, b) => a.sortOrder - b.sortOrder),
    server_create: ({ input }) => {
      const i = input as T.ServerInput;
      if (!i.name?.trim()) throw err("invalid_input", "Invalid input", "Give the server a name.");
      if (!i.host?.trim()) throw err("invalid_input", "Invalid input", "Enter a hostname or IP address.");
      if (!i.username?.trim()) throw err("invalid_input", "Invalid input", "Enter the SSH username.");
      const p: T.ServerProfile = {
        id: "srv-" + uid(),
        name: i.name.trim(),
        host: i.host.trim(),
        port: i.port,
        username: i.username.trim(),
        authMethod: i.authMethod,
        keyPath: i.keyPath,
        hasPassword: i.password.action === "set" && !!i.password.value,
        hasPassphrase: i.passphrase.action === "set",
        hasKeyData: i.keyData.action === "set",
        group: i.group?.trim() || null,
        tags: [...new Set(i.tags.map((t) => t.trim()).filter(Boolean))],
        favorite: i.favorite,
        color: i.color,
        notes: i.notes,
        proxy: i.proxy,
        jumpHostId: i.jumpHostId,
        keepaliveSecs: i.keepaliveSecs,
        connectTimeoutSecs: i.connectTimeoutSecs,
        autoReconnect: i.autoReconnect,
        useTmux: i.useTmux,
        startupDir: i.startupDir,
        startupCommand: i.startupCommand,
        sortOrder: servers.length,
        createdAt: now(),
        updatedAt: now(),
        lastConnectedAt: null,
      };
      servers.push(p);
      return p;
    },
    server_update: ({ id, input }) => {
      const s = server(id);
      const i = input as T.ServerInput;
      Object.assign(s, {
        name: i.name,
        host: i.host,
        port: i.port,
        username: i.username,
        authMethod: i.authMethod,
        keyPath: i.keyPath,
        group: i.group || null,
        tags: i.tags,
        favorite: i.favorite,
        color: i.color,
        notes: i.notes,
        proxy: i.proxy,
        jumpHostId: i.jumpHostId,
        keepaliveSecs: i.keepaliveSecs,
        connectTimeoutSecs: i.connectTimeoutSecs,
        autoReconnect: i.autoReconnect,
        useTmux: i.useTmux,
        startupDir: i.startupDir,
        startupCommand: i.startupCommand,
        updatedAt: now(),
      });
      if (i.password.action === "set") s.hasPassword = !!i.password.value;
      if (i.password.action === "clear") s.hasPassword = false;
      return { ...s };
    },
    server_delete: ({ id }) => {
      servers = servers.filter((s) => s.id !== id);
      statuses.delete(id);
    },
    server_duplicate: ({ id }) => {
      const s = server(id);
      const c = { ...s, id: "srv-" + uid(), name: `${s.name} (copy)`, sortOrder: s.sortOrder + 0.5, createdAt: now(), lastConnectedAt: null };
      servers.push(c);
      return c;
    },
    server_set_favorite: ({ id, favorite }) => Object.assign(server(id), { favorite }),
    server_rename: ({ id, name }) => Object.assign(server(id), { name }),
    servers_set_group: ({ ids, group }) => {
      for (const id of ids) server(id).group = group;
    },
    servers_reorder: ({ ids }) => {
      (ids as string[]).forEach((id, i) => {
        const s = servers.find((x) => x.id === id);
        if (s) s.sortOrder = i;
      });
    },
    ssh_config_scan: () => [
      { alias: "github-runner", host: "10.0.0.31", port: 22, username: "runner", identityFile: "C:\\Users\\David\\.ssh\\id_ed25519", proxyJump: null, alreadyImported: false },
      { alias: "backup-box", host: "backup.example.net", port: 2200, username: "borg", identityFile: null, proxyJump: "github-runner", alreadyImported: false },
      { alias: "prod", host: "203.0.113.10", port: 22, username: "deploy", identityFile: null, proxyJump: null, alreadyImported: true },
    ],
    ssh_config_import: ({ hosts }) =>
      (hosts as T.SshConfigHost[]).map((hh, i) => {
        const p = h.server_create({
          input: {
            name: hh.alias,
            host: hh.host,
            port: hh.port,
            username: hh.username ?? "root",
            authMethod: hh.identityFile ? "key" : "password",
            keyPath: hh.identityFile,
            password: { action: "keep" },
            passphrase: { action: "keep" },
            keyData: { action: "keep" },
            group: "Imported",
            tags: ["ssh-config"],
            favorite: false,
            color: null,
            notes: null,
            proxy: null,
            proxyPassword: { action: "keep" },
            jumpHostId: null,
            keepaliveSecs: 30,
            connectTimeoutSecs: 15,
            autoReconnect: true,
            useTmux: false,
            startupDir: null,
            startupCommand: null,
          } satisfies T.ServerInput,
        }) as T.ServerProfile;
        p.sortOrder = servers.length + i;
        return p;
      }),
    known_hosts_list: () => knownHosts,
    known_host_forget: ({ host, port }) => {
      knownHosts = knownHosts.filter((k) => !(k.host === host && k.port === port));
    },

    // ───── connections
    connect: async ({ serverId, password }) => {
      const s = server(serverId);
      if (status(serverId).state.state === "connected") return status(serverId);
      setStatus(serverId, { state: "connecting" });
      await sleep(350);
      if (s.id === "srv-old") {
        const e = err("connection_refused", "Connection refused", `Unable to connect to SSH on port ${s.port}.`, [`The SSH service on ${s.host} may be offline`, `Port ${s.port} may be wrong or blocked`, "A firewall may be blocking the connection"], "Connection refused (os error 111)");
        setStatus(serverId, { state: "failed", error: e });
        throw e;
      }
      if (s.authMethod === "password" && !s.hasPassword && !password) {
        const e = err("need_password", "Password required", `Enter the password for ${s.username}@${s.host}.`);
        setStatus(serverId, { state: "failed", error: e });
        throw e;
      }
      const key = `${serverId}:${s.port}`;
      if (!trusted.has(key)) {
        const prompt: T.HostKeyPrompt = { requestId: uid(), serverId, host: s.host, port: s.port, algorithm: "ssh-ed25519", fingerprint: "SHA256:Qm9x" + uid() + "Hn3kP1Zr8cT0vW5yA2", previousFingerprint: null };
        const decision = await new Promise<T.HostKeyDecision>((resolve) => {
          pendingKeys.set(prompt.requestId, { prompt, resolve });
          emit("connection://host-key", prompt);
        });
        if (decision === "reject") {
          const e = err("host_key_rejected", "Connection cancelled", "The server's host key was not trusted.");
          setStatus(serverId, { state: "failed", error: e });
          throw e;
        }
        if (decision === "trust") {
          trusted.add(key);
          knownHosts.push({ host: s.host, port: s.port, algorithm: "ssh-ed25519", fingerprint: prompt.fingerprint, addedAt: now() });
        }
      }
      await sleep(250);
      s.lastConnectedAt = now();
      return setStatus(serverId, { state: "connected", since: now() }, { latencyMs: 38, fingerprint: "ssh-ed25519 SHA256:k2F9cQx0bV7m1nJ8pL3sR6tW4yZ5aB2cD7eF0gH1iJ8", serverBanner: null });
    },
    disconnect: ({ serverId }) => {
      const m = monitors.get(serverId);
      if (m) clearInterval(m.timer);
      monitors.delete(serverId);
      setStatus(serverId, { state: "disconnected" });
      for (const sh of shells.values()) if (sh.serverId === serverId) sh.exit(null);
    },
    connection_statuses: () => [...statuses.values()],
    host_key_answer: ({ requestId, decision }) => {
      const p = pendingKeys.get(requestId);
      pendingKeys.delete(requestId);
      p?.resolve(decision);
      return !!p;
    },
    host_key_pending: () => [...pendingKeys.values()].map((p) => p.prompt),

    // ───── terminals
    terminal_open: ({ req, onEvent }) => {
      const r = req as T.TerminalOpenRequest;
      requireConn(r.serverId);
      const s = server(r.serverId);
      const id = "term-" + uid();
      const sh = new MockShell(id, r.serverId, s, fsFor(r.serverId), (ev) => (onEvent as MockChannel<T.TerminalEvent>).onmessage(ev), r.command ?? null, r.cwd ?? null);
      shells.set(id, sh);
      sh.start();
      return { id, serverId: r.serverId, title: s.name, tmuxSession: r.tmuxSession ?? (s.useTmux ? "bbx-" + uid().slice(0, 6) : null) } satisfies T.TerminalInfo;
    },
    terminal_open_local: ({ shellId, onEvent }) => {
      const id = "local-" + uid();
      const sh = new MockShell(id, null, null, localFs, (ev) => (onEvent as MockChannel<T.TerminalEvent>).onmessage(ev), null, null, shellId ?? "pwsh");
      shells.set(id, sh);
      sh.start();
      return { id, serverId: null, title: shellId === "cmd" ? "Command Prompt" : "PowerShell", tmuxSession: null } satisfies T.TerminalInfo;
    },
    terminal_write: ({ id, data }) => shells.get(id)?.input(data),
    terminal_resize: ({ id, cols, rows }) => shells.get(id)?.resize(cols, rows),
    terminal_close: ({ id }) => {
      shells.get(id)?.dispose();
      shells.delete(id);
    },
    local_shells: () => [
      { id: "pwsh", name: "PowerShell 7", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: ["-NoLogo"], isDefault: true },
      { id: "powershell", name: "Windows PowerShell", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoLogo"], isDefault: false },
      { id: "cmd", name: "Command Prompt", path: "C:\\Windows\\System32\\cmd.exe", args: [], isDefault: false },
      { id: "wsl", name: "WSL", path: "C:\\Windows\\System32\\wsl.exe", args: [], isDefault: false },
    ],
    tmux_sessions: () => ["bbx-a1b2c3", "work"],

    // ───── remote files
    sftp_home: ({ serverId }) => {
      requireConn(serverId);
      return `/home/${server(serverId).username}`;
    },
    sftp_list: async ({ serverId, path }) => {
      requireConn(serverId);
      await sleep(60);
      const fs = fsFor(serverId);
      const p = !path || path === "~" ? `/home/${server(serverId).username}` : path;
      const n = fs.get(p);
      if (!n) throw err("not_found", "Not found", `"${p}" does not exist on the server.`);
      if (n.kind !== "dir") throw err("not_a_directory", "Not a folder", `"${p}" is not a folder.`);
      return { path: p, parent: parent(p), entries: children(fs, p, "/") } satisfies T.DirListing;
    },
    sftp_stat: ({ serverId, path }) => {
      const n = fsFor(serverId).get(path);
      if (!n) throw err("not_found", "Not found", `"${path}" does not exist on the server.`);
      return entry(path, n);
    },
    sftp_mkdir: ({ serverId, path }) => {
      const fs = fsFor(serverId);
      if (fs.has(path)) throw err("already_exists", "Already exists", `"${path.split("/").pop()}" already exists.`);
      fs.set(path, { kind: "dir", mtime: now(), mode: 0o755, owner: server(serverId).username });
    },
    sftp_create_file: ({ serverId, path }) => {
      const fs = fsFor(serverId);
      if (fs.has(path)) throw err("already_exists", "Already exists", `"${path.split("/").pop()}" already exists.`);
      fs.set(path, { kind: "file", content: "", size: 0, mtime: now(), mode: 0o644, owner: server(serverId).username });
    },
    sftp_rename: ({ serverId, from, to }) => {
      const fs = fsFor(serverId);
      if (fs.has(to)) throw err("already_exists", "Name already used", `"${to.split("/").pop()}" already exists in this folder.`);
      for (const [p, n] of [...fs]) {
        if (p === from || p.startsWith(from + "/")) {
          fs.delete(p);
          fs.set(to + p.slice(from.length), n);
        }
      }
    },
    sftp_delete: ({ serverId, paths, confirmed }) => {
      if (!confirmed) throw err("confirmation_required", "Confirmation required", "Deleting files changes the server and must be explicitly confirmed.");
      const fs = fsFor(serverId);
      let n = 0;
      for (const path of paths as string[]) for (const p of [...fs.keys()]) if (p === path || p.startsWith(path + "/")) (fs.delete(p), n++);
      return n;
    },
    sftp_copy: ({ serverId, from, to }) => {
      const fs = fsFor(serverId);
      for (const [p, n] of [...fs]) if (p === from || p.startsWith(from + "/")) fs.set(to + p.slice(from.length), { ...n, mtime: now() });
    },
    sftp_move: ({ serverId, paths, toDir }) =>
      (paths as string[]).map((p) => {
        const dest = join(toDir, p.split("/").pop()!);
        h.sftp_rename({ serverId, from: p, to: dest });
        return dest;
      }),
    sftp_chmod: ({ serverId, path, mode }) => {
      const n = fsFor(serverId).get(path);
      if (n) n.mode = mode;
    },
    sftp_read_text: async ({ serverId, path }) => {
      await sleep(80);
      const n = fsFor(serverId).get(path);
      if (!n) throw err("not_found", "Not found", `"${path}" does not exist on the server.`);
      if (n.kind === "dir") throw err("is_a_directory", "That's a folder", "Folders cannot be opened in the editor.");
      if ((n.size ?? 0) > 20 * 2 ** 20) throw err("unsupported", "File too large", "Files over 20 MB cannot be opened in the editor.");
      return { path, content: n.content ?? "", encoding: "utf-8", size: n.content?.length ?? 0, modified: n.mtime, permissions: n.mode, eol: "lf" } satisfies T.TextFile;
    },
    sftp_write_text: async ({ serverId, path, content, expectedMtime }) => {
      await sleep(120);
      const fs = fsFor(serverId);
      const n = fs.get(path);
      if (n && expectedMtime != null && n.mtime !== expectedMtime)
        throw err("already_exists", "File changed on the server", "Someone else modified this file after you opened it.", ["Reload the file to see the latest version", 'Or use "Save anyway" to overwrite their changes']);
      const nn: MockNode = { kind: "file", content, size: content.length, mtime: now() + Math.floor(Math.random() * 3), mode: n?.mode ?? 0o644, owner: n?.owner ?? "deploy" };
      fs.set(path, nn);
      return entry(path, nn);
    },
    sftp_search: ({ serverId, root, query }) => {
      const q = String(query).toLowerCase();
      return [...fsFor(serverId)].filter(([p]) => p.startsWith(root) && p.split("/").pop()!.toLowerCase().includes(q)).map(([p, n]) => entry(p, n));
    },
    sftp_dir_size: () => 182_334_211,

    // ───── local files
    local_home: () => "C:\\Users\\David",
    local_list: ({ path }) => {
      if (!path) return { path: "", parent: null, entries: [{ name: "C:", path: "C:\\", kind: "dir", linkIsDir: false, size: 0, modified: null, permissions: null, owner: null, group: null, hidden: false }] } satisfies T.DirListing;
      const n = localFs.get(path);
      if (!n) throw err("not_found", "Not found", `"${path}" does not exist.`);
      return { path, parent: path.length <= 3 ? "" : lparent(path), entries: children(localFs, path, "\\") } satisfies T.DirListing;
    },
    local_stat: ({ path }) => entry(path, localFs.get(path)!, "\\"),
    local_mkdir: ({ dir, name }) => {
      const p = ljoin(dir, name);
      localFs.set(p, { kind: "dir", mtime: now(), mode: 0o755 });
      return p;
    },
    local_create_file: ({ dir, name }) => {
      const p = ljoin(dir, name);
      localFs.set(p, { kind: "file", size: 0, content: "", mtime: now(), mode: 0o644 });
      return p;
    },
    local_rename: ({ path, newName }) => {
      const dest = ljoin(lparent(path), newName);
      const n = localFs.get(path)!;
      localFs.delete(path);
      localFs.set(dest, n);
      return dest;
    },
    local_delete: ({ paths, confirmed }) => {
      if (!confirmed) throw err("confirmation_required", "Confirmation required", "Deleting files must be confirmed.");
      for (const path of paths as string[]) for (const p of [...localFs.keys()]) if (p === path || p.startsWith(path + "\\")) localFs.delete(p);
    },
    local_copy: ({ paths, toDir }) => (paths as string[]).map((p) => {
      const d = ljoin(toDir, p.split("\\").pop()!);
      localFs.set(d, { ...localFs.get(p)! });
      return d;
    }),
    local_move: ({ paths, toDir }) => (paths as string[]).map((p) => h.local_rename({ path: p, newName: p.split("\\").pop() }) && ljoin(toDir, p.split("\\").pop()!)),
    local_search: ({ root, query }) => [...localFs].filter(([p]) => p.startsWith(root) && p.toLowerCase().includes(String(query).toLowerCase())).map(([p, n]) => entry(p, n, "\\")),
    local_open: () => undefined,
    local_reveal: () => undefined,
    open_url: ({ url }) => {
      window.open(url, "_blank", "noopener");
    },

    // ───── transfers
    transfer_start: ({ req }) => {
      const r = req as T.TransferRequest;
      requireConn(r.serverId);
      const name = r.direction === "upload" ? r.localPath.split(/[\\/]/).pop()! : r.remotePath.split("/").pop()!;
      const size = r.direction === "upload" ? localFs.get(r.localPath)?.size ?? 38_000_000 : fsFor(r.serverId).get(r.remotePath)?.size ?? 24_000_000;
      const info: T.TransferInfo = {
        id: "tr-" + uid(),
        serverId: r.serverId,
        direction: r.direction,
        name,
        localPath: r.localPath,
        remotePath: r.remotePath,
        isDir: false,
        state: "queued",
        totalBytes: size,
        transferredBytes: 0,
        filesTotal: 1,
        filesDone: 0,
        speedBps: 0,
        etaSecs: null,
        currentFile: name,
        error: null,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
      };
      transfers.set(info.id, { info });
      emit("transfer://update", { ...info });
      setTimeout(() => runTransfer(info.id), 150);
      return info;
    },
    transfer_start_many: ({ reqs }) => (reqs as T.TransferRequest[]).map((req) => h.transfer_start({ req })),
    transfers_list: () => [...transfers.values()].map((t) => t.info),
    transfer_pause: ({ id }) => {
      const t = transfers.get(id)!;
      clearInterval(t.timer);
      t.info.state = "paused";
      t.info.speedBps = 0;
      emit("transfer://update", { ...t.info });
    },
    transfer_resume: ({ id }) => runTransfer(id),
    transfer_retry: ({ id }) => runTransfer(id),
    transfer_cancel: ({ id }) => {
      const t = transfers.get(id)!;
      clearInterval(t.timer);
      t.info.state = "cancelled";
      t.info.finishedAt = now();
      emit("transfer://update", { ...t.info });
    },
    transfers_clear_finished: () => {
      for (const [id, t] of transfers) if (t.info.state === "completed" || t.info.state === "cancelled") transfers.delete(id);
    },

    // ───── monitoring & system
    monitor_start: ({ serverId, intervalMs }) => startMonitor(serverId, intervalMs),
    monitor_stop: ({ serverId }) => {
      const m = monitors.get(serverId);
      if (m) clearInterval(m.timer);
    },
    monitor_history: ({ serverId }) => monitors.get(serverId)?.history ?? [],
    system_info: ({ serverId }) => ({ hostname: server(serverId).name.toLowerCase().replace(/\s+/g, "-"), os: "Ubuntu 24.04.1 LTS", kernel: "Linux 6.8.0-45-generic", arch: "x86_64", cpuModel: "AMD EPYC 7763 64-Core Processor", cpuCores: serverId === "srv-db" ? 8 : 4 }),
    processes_list: async () => {
      await sleep(120);
      return PROCESSES.map((p) => ({ ...p, cpuPercent: Math.max(0, p.cpuPercent + (Math.random() - 0.5) * p.cpuPercent * 0.4) }));
    },
    process_details: ({ pid }) => `Command: ${PROCESSES.find((p) => p.pid === pid)?.command}\nWorking dir: /var/www/shop\nOpen files: 42\n\nName:\tnode\nState:\tS (sleeping)\nThreads:\t11\nVmRSS:\t402000 kB`,
    process_signal: ({ confirmed }) => {
      if (!confirmed) throw err("confirmation_required", "Confirmation required", "Stopping a process changes the server and must be explicitly confirmed.");
    },
    ports_list: () => PORTS,
    services_list: async ({ serverId }) => {
      await sleep(100);
      if (!services.has(serverId)) services.set(serverId, SERVICES.map((s) => ({ ...s })));
      return services.get(serverId);
    },
    service_status: ({ unit }) => `● ${unit} - service\n     Loaded: loaded (/lib/systemd/system/${unit}; enabled; preset: enabled)\n     Active: active (running) since Mon 2026-09-28 09:12:44 UTC; 5 days ago\n   Main PID: 811 (nginx)\n      Tasks: 5 (limit: 9387)\n     Memory: 14.2M\n        CPU: 1min 32.104s`,
    service_action: async ({ serverId, unit, action, confirmed, sudoPassword }) => {
      if (!confirmed) throw err("confirmation_required", "Confirmation required", "Changing a service must be explicitly confirmed.");
      if (serverId === "srv-dev" && !sudoPassword) throw err("sudo_password_required", "Administrator password needed", "This action needs sudo. Enter your sudo password to continue.");
      await sleep(400);
      const s = services.get(serverId)?.find((x) => x.name === unit);
      if (s) {
        if (action === "stop") Object.assign(s, { activeState: "inactive", subState: "dead" });
        if (action === "start" || action === "restart") Object.assign(s, { activeState: "active", subState: "running" });
        if (action === "enable") s.enabledState = "enabled";
        if (action === "disable") s.enabledState = "disabled";
      }
    },
    sudo_remember: () => undefined,

    // ───── docker
    docker_status: ({ serverId }) =>
      serverId === "srv-dev"
        ? { available: false, version: null, usesSudo: false, reason: err("docker_unavailable", "Docker is not installed", "The `docker` command was not found on this server.", ["Install Docker Engine (https://docs.docker.com/engine/install/)"]) }
        : { available: true, version: "27.3.1", usesSudo: false, reason: null },
    docker_containers: ({ serverId }) => {
      if (!containersByServer.has(serverId)) containersByServer.set(serverId, seedContainers());
      return containersByServer.get(serverId);
    },
    docker_images: () => IMAGES,
    docker_volumes: () => [{ name: "shop_pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/shop_pgdata/_data" }, { name: "uptime-kuma", driver: "local", mountpoint: "/var/lib/docker/volumes/uptime-kuma/_data" }],
    docker_networks: () => [{ id: "a1", name: "bridge", driver: "bridge", scope: "local" }, { id: "b2", name: "shop_default", driver: "bridge", scope: "local" }, { id: "c3", name: "host", driver: "host", scope: "local" }],
    docker_stats: () => [
      { id: "a1b2c3d4e5f6", name: "shop-web-1", cpuPercent: `${(8 + Math.random() * 10).toFixed(2)}%`, memUsage: "312MiB / 7.6GiB", memPercent: "4.01%", netIo: "1.2GB / 3.4GB", blockIo: "12MB / 0B", pids: "23" },
      { id: "b2c3d4e5f6a1", name: "shop-redis-1", cpuPercent: "0.41%", memUsage: "18MiB / 7.6GiB", memPercent: "0.23%", netIo: "220MB / 190MB", blockIo: "0B / 4MB", pids: "5" },
      { id: "c3d4e5f6a1b2", name: "shop-worker-1", cpuPercent: "2.10%", memUsage: "140MiB / 7.6GiB", memPercent: "1.80%", netIo: "80MB / 22MB", blockIo: "0B / 0B", pids: "11" },
    ],
    docker_inspect: ({ id }) => JSON.stringify([{ Id: id, Name: "/shop-web-1", Config: { Image: "shop-web:2.4.1", Env: ["NODE_ENV=production"] }, State: { Status: "running", Pid: 2211 }, HostConfig: { RestartPolicy: { Name: "unless-stopped" } } }], null, 2),
    docker_container_action: async ({ serverId, id, action, confirmed }) => {
      if (!confirmed) throw err("confirmation_required", "Confirmation required", "Changing a container must be explicitly confirmed.");
      await sleep(300);
      const list = containersByServer.get(serverId) ?? [];
      const c = list.find((x) => x.id === id);
      if (!c) return;
      if (action === "remove") containersByServer.set(serverId, list.filter((x) => x.id !== id));
      if (action === "stop") Object.assign(c, { state: "exited", status: "Exited (0) just now" });
      if (action === "start" || action === "restart" || action === "unpause") Object.assign(c, { state: "running", status: "Up 1 second" });
      if (action === "pause") Object.assign(c, { state: "paused", status: "Up 3 days (Paused)" });
    },
    docker_remove_image: () => undefined,
    docker_remove_volume: () => undefined,
    docker_exec_command: ({ id }) => `docker exec -it ${id} sh`,

    // ───── git
    git_discover: () => ["/var/www/shop", "/home/deploy/dotfiles"],
    git_status: ({ repo }) => ({ path: repo, branch: "main", upstream: "origin/main", ahead: 1, behind: 2, files: [
      { path: "src/server.ts", staged: "", unstaged: "M", untracked: false },
      { path: "package.json", staged: "M", unstaged: "", untracked: false },
      { path: "notes.txt", staged: "", unstaged: "?", untracked: true },
    ] }),
    git_branches: () => [
      { name: "main", isRemote: false, isCurrent: true, commit: "9f2c1e7", upstream: "origin/main" },
      { name: "feature/paystack", isRemote: false, isCurrent: false, commit: "4a8d2b6", upstream: null },
      { name: "origin/main", isRemote: true, isCurrent: false, commit: "2b6c1e9", upstream: null },
    ],
    git_log: () => GIT_LOG,
    git_diff: () => "diff --git a/src/server.ts b/src/server.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/server.ts\n+++ b/src/server.ts\n@@ -3,5 +3,6 @@ import express from \"express\";\n const app = express();\n \n-app.get(\"/health\", (_req, res) => res.json({ ok: true }));\n+app.get(\"/health\", (_req, res) => res.json({ ok: true, version: \"2.4.1\" }));\n+app.get(\"/ready\", (_req, res) => res.sendStatus(204));\n \n app.listen(3000, () => console.log(\"listening on :3000\"));\n",
    git_show: ({ hash }) => `commit ${hash}\nAuthor: David <david@brainbox.dev>\n\n    feat(checkout): add Paystack payment option\n\n src/checkout.ts | 42 +++++++++++++++++++++++++++++++++\n 1 file changed, 42 insertions(+)\n`,
    git_action: async ({ action, confirmed }) => {
      if (!confirmed && action !== "fetch") throw err("confirmation_required", "Confirmation required", "This Git operation must be explicitly confirmed.");
      await sleep(600);
      return action === "pull" ? "Updating 9f2c1e7..2b6c1e9\nFast-forward\n src/checkout.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n" : "Everything up-to-date\n";
    },
    git_checkout: ({ branch }) => `Switched to branch '${branch}'\n`,

    // ───── logs
    logs_start: ({ req, onEvent }) => {
      const id = "log-" + uid();
      const ch = onEvent as MockChannel<T.StreamEvent>;
      const r = req as T.LogStreamRequest;
      const src = r.source.kind;
      const line = (i: number) => {
        const ts = new Date(Date.now() - (200 - i) * 1000).toISOString().replace("T", " ").slice(0, 19);
        const levels = ["INFO", "INFO", "INFO", "WARN", "ERROR", "DEBUG"];
        const lv = levels[i % levels.length];
        if (src === "docker") return `${ts}Z GET /api/products/${i} 200 ${(Math.random() * 40).toFixed(1)}ms`;
        if (src === "file") return `203.0.113.${i % 250} - - [${ts}] "GET /products/${i} HTTP/1.1" 200 ${1200 + i}`;
        return `${ts} prod ${src === "service" ? (r.source as { unit: string }).unit.replace(".service", "") : "kernel"}[${811 + (i % 4)}]: ${lv} ${lv === "ERROR" ? "upstream timed out (110: Connection timed out) while reading response header" : lv === "WARN" ? "worker connections are not enough" : "request processed"} #${i}`;
      };
      ch.onmessage({ type: "lines", lines: Array.from({ length: Math.min(r.lines, 200) }, (_, i) => line(i)) });
      let i = 200;
      const timer = r.follow ? setInterval(() => ch.onmessage({ type: "lines", lines: [line(i++), line(i++)] }), 700) : null;
      if (!r.follow) ch.onmessage({ type: "end", code: 0 });
      logTimers.set(id, timer);
      return id;
    },
    logs_stop: ({ id }) => {
      const t = logTimers.get(id);
      if (t) clearInterval(t);
      logTimers.delete(id);
    },
    logs_discover: () => [
      { path: "/var/log/nginx/access.log", size: 18_220_111 },
      { path: "/var/log/nginx/error.log", size: 220_110 },
      { path: "/var/log/syslog", size: 4_112_090 },
      { path: "/home/deploy/.pm2/logs/shop-out.log", size: 9_002_113 },
    ],
    logs_export: () => 1_204_331,

    // ───── tunnels
    tunnels_list: () => tunnels,
    tunnel_statuses: () => [...tunnelStatus.values()],
    tunnel_save: ({ id, input }) => {
      const i = input as T.TunnelInput;
      if (!i.name.trim()) throw err("invalid_input", "Invalid input", "Give the tunnel a name.");
      const t: T.TunnelConfig = { id: id ?? "tun-" + uid(), ...i, bindHost: i.bindHost || "127.0.0.1" };
      tunnels = [...tunnels.filter((x) => x.id !== t.id), t];
      return t;
    },
    tunnel_delete: ({ id }) => {
      tunnels = tunnels.filter((t) => t.id !== id);
      tunnelStatus.delete(id);
    },
    tunnel_start: ({ id }) => {
      const t = tunnels.find((x) => x.id === id)!;
      requireConn(t.serverId);
      const st: T.TunnelStatus = { id, state: "running", activeConnections: 0, bytesIn: 0, bytesOut: 0, error: null };
      tunnelStatus.set(id, st);
      emit("tunnel://status", st);
      const timer = setInterval(() => {
        const s = tunnelStatus.get(id);
        if (!s || s.state !== "running") return clearInterval(timer);
        s.bytesIn += Math.floor(Math.random() * 40000);
        s.bytesOut += Math.floor(Math.random() * 9000);
        s.activeConnections = Math.floor(Math.random() * 3);
        emit("tunnel://status", { ...s });
      }, 1000);
      return st;
    },
    tunnel_stop: ({ id }) => {
      tunnelStatus.delete(id);
      emit("tunnel://status", { id, state: "stopped", activeConnections: 0, bytesIn: 0, bytesOut: 0, error: null });
    },

    // ───── commands
    snippets_list: () => snippets,
    snippet_save: ({ id, input }) => {
      const i = input as T.SnippetInput;
      if (!i.name.trim() || !i.command.trim()) throw err("invalid_input", "Invalid input", "A command needs a name and the command text.");
      const s: T.Snippet = { id: id ?? "sn-" + uid(), ...i, createdAt: now(), updatedAt: now() };
      snippets = [...snippets.filter((x) => x.id !== s.id), s];
      return s;
    },
    snippet_delete: ({ id }) => {
      snippets = snippets.filter((s) => s.id !== id);
    },
    command_assess: ({ command }) => assessMock(command),
    command_run: async ({ serverId, command, confirmed }) => {
      const a = assessMock(command);
      if (a.risk !== "read_only" && !confirmed) throw { ...err("confirmation_required", "Confirmation required", "This command changes the server and must be explicitly confirmed."), causes: a.reasons };
      requireConn(serverId);
      await sleep(500);
      return { stdout: `$ ${command}\nDone on ${server(serverId).name}.\n`, stderr: "", exitCode: 0, durationMs: 512, truncated: false } satisfies T.ExecOutput;
    },
    broadcast_run: async ({ serverIds, command, confirmed }) => {
      const a = assessMock(command);
      if (a.risk !== "read_only" && !confirmed) throw { ...err("confirmation_required", "Confirmation required", "This command changes the server and must be explicitly confirmed."), causes: a.reasons, details: a.risk === "dangerous" ? "Dangerous" : "Mutating" };
      const bid = uid();
      const results = await Promise.all(
        (serverIds as string[]).map(async (sid, i) => {
          await sleep(300 + i * 250);
          const s = server(sid);
          const r: T.BroadcastResult =
            status(sid).state.state === "connected"
              ? { broadcastId: bid, serverId: sid, serverName: s.name, output: { stdout: command.startsWith("git pull") ? "Already up to date.\n" : `${s.name.toLowerCase().replace(/ /g, "-")}: ok\n`, stderr: "", exitCode: 0, durationMs: 300 + i * 250, truncated: false }, error: null }
              : { broadcastId: bid, serverId: sid, serverName: s.name, output: null, error: err("not_connected", "Not connected", `${s.name} is not connected.`) };
          emit("broadcast://result", r);
          return r;
        }),
      );
      return { broadcastId: bid, results };
    },

    // ───── workspaces, settings
    workspaces_list: () => workspaces,
    workspace_create: ({ name, serverIds }) => {
      const w: T.Workspace = { id: "ws-" + uid(), name, icon: null, serverIds, layout: {}, createdAt: now(), updatedAt: now() };
      workspaces = [...workspaces, w];
      return w;
    },
    workspace_save: ({ workspace }) => {
      const w = { ...(workspace as T.Workspace), updatedAt: now() };
      workspaces = workspaces.map((x) => (x.id === w.id ? w : x));
      return w;
    },
    workspace_delete: ({ id }) => {
      workspaces = workspaces.filter((w) => w.id !== id);
    },
    ui_state_get: ({ key }) => kv.get(key) ?? null,
    ui_state_set: ({ key, value }) => {
      kv.set(key, value);
    },
    settings_get: () => settings,
    settings_save: ({ settings: s }) => {
      settings = s as T.Settings;
      return settings;
    },

    // ───── AI
    ai_set_key: ({ key }) => {
      settings = { ...settings, ai: { ...settings.ai, hasApiKey: !!key } };
      return settings;
    },
    ai_new_chat: ({ serverId }) => {
      const id = "chat-" + uid();
      chats.set(id, { serverId, items: [], pending: null, step: 0 });
      return id;
    },
    ai_send: async ({ chatId, text }) => {
      const c = chats.get(chatId)!;
      if (!settings.ai.enabled) throw err("ai", "AI assistant is off", "Enable Brainbox AI in Settings → AI to use the assistant.");
      c.items.push({ role: "user", text });
      await sleep(700);
      c.items.push({ role: "assistant", text: "Let me check what's using resources on the server." });
      c.items.push({ role: "tool", name: "get_system_overview", input: "", output: "uptime/load:  12:01:33 up 14 days,  load average: 3.92, 3.41, 2.98\n\n               total        used        free\nMem:           7.6Gi       6.9Gi       312Mi\n\ntop cpu:\n  PID USER     %CPU %MEM COMMAND\n 1022 deploy   87.1  9.8 node", ok: true });
      c.items.push({ role: "tool", name: "read_logs", input: "source: service, target: shop", output: "Oct 03 11:58:02 node[1022]: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", ok: true });
      c.items.push({ role: "assistant", text: "Your **Node app (PID 1022)** is pinned at ~87% CPU and the logs show it hitting its **heap limit**, so it's thrashing GC.\n\nA restart frees memory immediately; long-term, raise the heap size or fix the leak." });
      const p: T.AiProposal = { id: uid(), serverId: c.serverId, command: "pm2 restart shop --update-env", reason: "Restart the app to recover memory (≈2s downtime).", risk: "mutating" };
      c.pending = p;
      c.items.push({ role: "proposal", proposal: p, status: "pending" });
      return { chatId, items: c.items, pending: p } satisfies T.AiTurnResult;
    },
    ai_decide: async ({ chatId, proposalId, approve }) => {
      const c = chats.get(chatId)!;
      for (const it of c.items) if (it.role === "proposal" && it.proposal.id === proposalId) it.status = approve ? "executed" : "rejected";
      c.pending = null;
      await sleep(600);
      if (approve) {
        c.items.push({ role: "tool", name: "run_approved_command", input: "pm2 restart shop --update-env", output: "[PM2] Applying action restartProcessId on app [shop](ids: [ 0 ])\n[PM2] [shop](0) ✓", ok: true });
        c.items.push({ role: "assistant", text: "Restarted ✅ CPU should settle within a minute. Want me to add `--max-old-space-size=2048` to the PM2 config?" });
      } else c.items.push({ role: "assistant", text: "No problem — I won't restart it. You can also investigate with a heap snapshot first." });
      return { chatId, items: c.items, pending: null } satisfies T.AiTurnResult;
    },
    ai_delete_chat: ({ chatId }) => {
      chats.delete(chatId);
    },

    app_info: () => ({ version: "0.1.0", dataDir: "C:\\Users\\David\\AppData\\Roaming\\com.brainbox.vps", vaultBackend: "windows-credential-manager", platform: "windows" }),
    app_quit: () => undefined,
  };
  const logTimers = new Map<string, ReturnType<typeof setInterval> | null>();

  // Auto-connect demo servers so screenshots show live data.
  if (!empty && !params.has("offline")) {
    for (const id of ["srv-prod", "srv-db"]) {
      setStatus(id, { state: "connected", since: now() }, { latencyMs: id === "srv-db" ? 22 : 41, fingerprint: "ssh-ed25519 SHA256:k2F9cQx0bV7m1nJ8pL3sR6tW4yZ5aB2cD7eF0gH1iJ8" });
    }
  }

  const backend: Backend = {
    kind: "mock",
    async invoke<R>(cmd: string, args: Record<string, unknown> = {}): Promise<R> {
      const fn = h[cmd];
      if (!fn) throw err("unsupported", "Not available", `The command "${cmd}" is not available in this build.`);
      await sleep(15);
      try {
        return (await fn(args as Record<string, any>)) as R;
      } catch (e) {
        throw e;
      }
    },
    async listen<P>(event: string, cb: (p: P) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      const set = listeners.get(event)!;
      const f = cb as (p: unknown) => void;
      set.add(f);
      return () => set.delete(f);
    },
    channel<M>(onMessage: (m: M) => void) {
      return new MockChannel<M>(onMessage);
    },
  };
  /** Test hook: simulate a dropped connection that the supervisor brings back. */
  const drop = (serverId: string, downMs = 1500) => {
    if (status(serverId).state.state !== "connected") return;
    for (const sh of shells.values()) if (sh.serverId === serverId) sh.suspend();
    setStatus(serverId, { state: "reconnecting", attempt: 1, next_retry_ms: downMs });
    setTimeout(() => {
      setStatus(serverId, { state: "connected", since: now() });
      for (const sh of shells.values()) if (sh.serverId === serverId) sh.resume();
      emit("app://notify", { kind: "success", title: "Reconnected", body: `${servers.find((x) => x.id === serverId)?.name ?? serverId} is back online.`, serverId });
    }, downMs);
  };
  (window as unknown as { __bbxMock?: unknown }).__bbxMock = { emit, statuses, servers: () => servers, drop };
  return backend;
}

function assessMock(command: string): T.CommandAssessment {
  const c = command.trim();
  if (/\brm\s+-[a-z]*[rf]|mkfs|\bdd\b|reboot|shutdown|--force|reset --hard|system prune|\bdrop\s+(database|table)/i.test(c)) return { risk: "dangerous", reasons: ["can cause irreversible damage or downtime"] };
  if (/^(ls|cat|tail|head|df|du|free|uptime|ps|top|whoami|id|uname|hostname|docker (ps|logs|stats|images)|git (status|log|diff)|systemctl status|journalctl|echo|pwd|ss|netstat|grep)\b/.test(c)) return { risk: "read_only", reasons: [] };
  return { risk: "mutating", reasons: [`\`${c.split(/\s+/)[0]}\` changes server state`] };
}
