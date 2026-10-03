/* A tiny simulated shell for the mock backend (bash-like or PowerShell-like). */
import type * as T from "@/types/generated";
import type { MockNode } from "./data";

const enc = new TextEncoder();
const b64 = (s: string) => {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[38;2;80;220;140m",
  blue: "\x1b[38;2;124;140;255m",
  violet: "\x1b[38;2;167;139;250m",
  cyan: "\x1b[38;2;56;189;248m",
  dim: "\x1b[2m",
  yellow: "\x1b[38;2;245;165;36m",
  red: "\x1b[38;2;239;68;68m",
};

export class MockShell {
  private line = "";
  private cwd: string;
  private history: string[] = [];
  private hIdx = 0;
  private closed = false;

  constructor(
    public id: string,
    public serverId: string | null,
    private server: T.ServerProfile | null,
    private fs: Map<string, MockNode>,
    private emit: (e: T.TerminalEvent) => void,
    private command: string | null,
    cwd: string | null,
    private flavor: string = "bash",
  ) {
    this.cwd = cwd ?? (server ? `/home/${server.username}` : "C:\\Users\\David");
  }

  private out(s: string) {
    if (!this.closed) this.emit({ type: "data", data: b64(s) });
  }

  private get isPwsh() {
    return !this.server && this.flavor !== "cmd";
  }

  private prompt() {
    if (!this.server) {
      this.out(this.flavor === "cmd" ? `${this.cwd}>` : `${C.blue}PS${C.reset} ${this.cwd}> `);
      return;
    }
    const home = `/home/${this.server.username}`;
    const shown = this.cwd.startsWith(home) ? "~" + this.cwd.slice(home.length) : this.cwd;
    const host = this.server.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    this.out(`${C.green}${this.server.username}@${host}${C.reset}:${C.blue}${shown}${C.reset}$ `);
  }

  start() {
    setTimeout(() => {
      if (this.command) {
        this.out(`${C.dim}# ${this.command}${C.reset}\r\n/ # `);
        return;
      }
      if (this.server) {
        this.out(
          `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\r\n\r\n` +
            `  System load:  0.52               Processes:             186\r\n` +
            `  Usage of /:   60.6% of 159.9GB   Users logged in:       1\r\n` +
            `  Memory usage: 46%                IPv4 address for eth0: ${this.server.host}\r\n\r\n` +
            `${C.dim}Last login: Fri Oct  2 18:22:41 2026 from 102.89.33.1${C.reset}\r\n`,
        );
      } else if (this.isPwsh) {
        this.out(`PowerShell 7.4.5\r\n`);
      } else {
        this.out(`Microsoft Windows [Version 10.0.26100.2033]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n`);
      }
      this.prompt();
    }, 120);
  }

  resize(_cols: number, _rows: number) {
    /* the simulated shell doesn't reflow */
  }

  exit(code: number | null) {
    if (this.closed) return;
    this.emit({ type: "exit", code });
    this.closed = true;
  }

  /** Simulate the SSH link dropping and coming back (tmux keeps the session). */
  suspend() {
    if (!this.closed) this.emit({ type: "suspended" });
  }
  resume() {
    if (this.closed) return;
    this.emit({ type: "resumed" });
    this.out(`\r\n${C.dim}[reattached to tmux session]${C.reset}\r\n`);
    this.prompt();
  }

  dispose() {
    this.closed = true;
  }

  input(data: string) {
    if (this.closed) return;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === "\x1b") {
        const seq = data.slice(i, i + 3);
        if (seq === "\x1b[A" || seq === "\x1b[B") {
          if (this.history.length) {
            this.hIdx = Math.max(0, Math.min(this.history.length, this.hIdx + (seq === "\x1b[A" ? -1 : 1)));
            const v = this.history[this.hIdx] ?? "";
            this.out("\b \b".repeat(this.line.length) + v);
            this.line = v;
          }
        }
        i += 2;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        this.out("\r\n");
        const cmd = this.line.trim();
        this.line = "";
        if (cmd) {
          this.history.push(cmd);
          this.hIdx = this.history.length;
        }
        this.run(cmd);
        if (!this.closed) this.prompt();
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length) {
          this.line = this.line.slice(0, -1);
          this.out("\b \b");
        }
      } else if (ch === "\x03") {
        this.out("^C\r\n");
        this.line = "";
        this.prompt();
      } else if (ch === "\x0c") {
        this.out("\x1b[2J\x1b[H");
        this.prompt();
        this.out(this.line);
      } else if (ch >= " ") {
        this.line += ch;
        this.out(ch);
      }
    }
  }

  private resolve(p: string) {
    if (!this.server) return p;
    if (!p || p === "~") return `/home/${this.server.username}`;
    if (p.startsWith("~/")) p = `/home/${this.server.username}/${p.slice(2)}`;
    const base = p.startsWith("/") ? [] : this.cwd.split("/").filter(Boolean);
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    return "/" + base.join("/");
  }

  private ls(path: string, long: boolean) {
    const dir = this.resolve(path || ".");
    const names: { name: string; n: MockNode }[] = [];
    for (const [p, n] of this.fs) {
      const par = p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/"));
      if (par === dir && p !== dir) names.push({ name: p.slice(p.lastIndexOf("/") + 1), n });
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    if (long) {
      for (const { name, n } of names) {
        const perm = (n.kind === "dir" ? "d" : "-") + "rwxr-xr-x";
        const nm = n.kind === "dir" ? `${C.blue}${C.bold}${name}${C.reset}` : n.mode & 0o100 ? `${C.green}${C.bold}${name}${C.reset}` : name;
        this.out(`${perm} 1 ${(n.owner ?? "root").padEnd(8)} ${(n.owner ?? "root").padEnd(8)} ${String(n.size ?? 4096).padStart(8)} Oct  3 12:00 ${nm}\r\n`);
      }
    } else {
      this.out(names.filter((x) => !x.name.startsWith(".")).map(({ name, n }) => (n.kind === "dir" ? `${C.blue}${C.bold}${name}${C.reset}` : name)).join("  ") + "\r\n");
    }
  }

  private run(cmd: string) {
    if (!cmd) return;
    const [prog, ...args] = cmd.split(/\s+/);
    if (!this.server) {
      switch (prog.toLowerCase()) {
        case "dir":
        case "ls":
        case "get-childitem":
          this.out(`\r\n    Directory: ${this.cwd}\r\n\r\nMode                 LastWriteTime         Length Name\r\n----                 -------------         ------ ----\r\nd----          10/3/2026 12:00 PM                Desktop\r\nd----          10/3/2026 12:00 PM                Documents\r\nd----          10/3/2026 12:00 PM                Downloads\r\nd----          10/3/2026 12:00 PM                Projects\r\n\r\n`);
          return;
        case "ssh":
          this.out(`${C.dim}Tip: use the server list on the left — Brainbox keeps your SSH sessions alive.${C.reset}\r\n`);
          return;
        case "cls":
        case "clear":
          this.out("\x1b[2J\x1b[H");
          return;
        case "exit":
          this.exit(0);
          return;
        default:
          this.out(this.isPwsh ? `${C.red}${prog}: The term '${prog}' is not recognized as a name of a cmdlet, function, script file, or executable program.${C.reset}\r\n` : `'${prog}' is not recognized as an internal or external command.\r\n`);
          return;
      }
    }
    switch (prog) {
      case "ls":
      case "ll":
        this.ls(args.filter((a) => !a.startsWith("-"))[0] ?? "", prog === "ll" || args.some((a) => a.includes("l")));
        return;
      case "cd": {
        const d = this.resolve(args[0] ?? "~");
        const n = this.fs.get(d);
        if (!n || n.kind !== "dir") this.out(`bash: cd: ${args[0]}: No such file or directory\r\n`);
        else this.cwd = d;
        return;
      }
      case "pwd":
        this.out(this.cwd + "\r\n");
        return;
      case "whoami":
        this.out(this.server.username + "\r\n");
        return;
      case "hostname":
        this.out(this.server.name.toLowerCase().replace(/\s+/g, "-") + "\r\n");
        return;
      case "uname":
        this.out("Linux prod 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\r\n");
        return;
      case "uptime":
        this.out(" 12:01:33 up 14 days,  3:12,  1 user,  load average: 0.52, 0.61, 0.58\r\n");
        return;
      case "echo":
        this.out(args.join(" ").replace(/^["']|["']$/g, "") + "\r\n");
        return;
      case "cat": {
        const n = this.fs.get(this.resolve(args[0] ?? ""));
        if (!n) this.out(`cat: ${args[0]}: No such file or directory\r\n`);
        else if (n.kind === "dir") this.out(`cat: ${args[0]}: Is a directory\r\n`);
        else this.out((n.content ?? "").replace(/\n/g, "\r\n"));
        return;
      }
      case "clear":
        this.out("\x1b[2J\x1b[H");
        return;
      case "df":
        this.out("Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/vda1       160G   97G   63G  61% /\r\n/dev/vdb1       500G  412G   88G  83% /mnt/backups\r\n");
        return;
      case "free":
        this.out("               total        used        free      shared  buff/cache   available\r\nMem:           7.6Gi       3.5Gi       1.1Gi        12Mi       3.0Gi       4.1Gi\r\nSwap:          2.0Gi       256Mi       1.8Gi\r\n");
        return;
      case "docker":
        this.out(`CONTAINER ID   IMAGE            STATUS       NAMES\r\na1b2c3d4e5f6   shop-web:2.4.1   Up 3 days    shop-web-1\r\nb2c3d4e5f6a1   redis:7-alpine   Up 3 days    shop-redis-1\r\n`);
        return;
      case "colors":
        for (let i = 0; i < 6; i++) {
          let row = "";
          for (let j = 0; j < 36; j++) row += `\x1b[48;5;${16 + i * 36 + j}m `;
          this.out(row + C.reset + "\r\n");
        }
        this.out(`${C.violet}truecolor ✓${C.reset}  ${C.cyan}unicode ✓ 🚀 世界 ✓${C.reset}\r\n`);
        return;
      case "htop":
      case "top":
        this.out(`${C.dim}(interactive programs run normally in the real app)${C.reset}\r\n`);
        return;
      case "exit":
      case "logout":
        this.out("logout\r\n");
        this.exit(0);
        return;
      default:
        this.out(`${prog}: command not found\r\n`);
    }
  }
}
