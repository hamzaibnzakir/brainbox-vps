# Brainbox VPS

A native Windows workstation for running Linux servers over SSH: terminals, a dual-pane SFTP file manager, a remote code editor, live monitoring, Docker, systemd services, logs, ports, SSH tunnels, Git, saved commands, multi-server broadcast and an approval-gated AI assistant — in one fast desktop app.

Built with **Tauri 2** (Rust backend, system WebView2 — no Electron), **russh / russh-sftp**, **React + TypeScript + Vite + Tailwind**, **xterm.js** and **Monaco**.

---

## Features

| Area | What you get |
| --- | --- |
| **Servers** | Add / edit / duplicate / rename / delete, groups, tags, favorites, colors, fuzzy search, sorting. Paste `user@host:port` into the host field. Import from `~/.ssh/config` (incl. `ProxyJump`). Password, private key (file or pasted, with passphrase), keyboard-interactive and SSH agent (Windows OpenSSH agent + Pageant). SOCKS5 / HTTP proxy, jump hosts, keepalive, timeouts, per-server startup directory/command. |
| **Connections** | One multiplexed SSH connection per server shared by every tool. Automatic reconnect with backoff; terminals suspend and resume, tmux sessions reattach, tunnels re-bind. Live status, latency, uptime and CPU/RAM/disk sparklines in the sidebar. |
| **Security** | Credentials encrypted with AES-256-GCM; the master key lives in Windows Credential Manager. Never logged, never sent anywhere except the server you connect to. Host keys verified on first connect (with `~/.ssh/known_hosts` import), loud warning when a key changes, Known hosts manager. Least-privilege Tauri capabilities — the UI has no generic filesystem or shell access. Destructive actions always need confirmation; sudo passwords are asked for, not stored. |
| **Terminal** | Tabs, unlimited splits (right/down), resize, zoom/fullscreen, search, truecolor + Unicode, clickable URLs, natural Windows clipboard (Ctrl+C copies a selection, otherwise interrupts; Ctrl+V / right-click paste), optional tmux persistence, reconnect without losing the session. |
| **Local terminal** | PowerShell 7, Windows PowerShell, CMD, Git Bash and WSL auto-detected (ConPTY). |
| **Files** | Dual-pane local ⇄ remote browser, drag & drop (including from Explorer), F5 transfer, rename, move, copy, delete, new file/folder, permissions, properties, folder size, search, hidden files toggle, open in editor. |
| **Transfers** | Background queue with pause / resume / cancel / retry, speed and ETA, folder transfers, resumable partial files, Windows-safe file names. |
| **Editor** | Monaco with 20+ languages (incl. nginx, dotenv, logs, Dockerfile, systemd units), search/replace, minimap, word wrap, format, unsaved indicator, save / save as / download / upload-over. Saves are atomic and detect when the file changed on the server meanwhile. |
| **Overview** | CPU, memory, swap, disks, network, load, uptime, processes and open ports with live graphs; configurable refresh (1–30 s). Pollers only run while needed. |
| **Processes / Services / Ports** | Sortable, filterable tables; signal or kill processes, start/stop/restart/enable/disable systemd units, view unit status, see which process owns a port. |
| **Docker** | Containers, images, volumes, networks, stats, logs, inspect, start/stop/restart/remove, exec shell — with a clear explanation when Docker is missing or the user lacks permission. Container stop/crash notifications. |
| **Logs** | One viewer for files, journald units and container logs: live tail, search, level filter, pause, clear, export. |
| **Tunnels** | Local (-L), remote (-R) and dynamic SOCKS (-D) forwards, saved per server, optional auto-start, live connection/traffic counters. |
| **Git** | Discover repositories; status, branches, history, diffs; fetch, pull, push and checkout (confirmed before running). |
| **Command Center** | Saved commands per server or global, keyboard shortcuts, risk assessment (read-only / changes server / dangerous), output capture. |
| **Broadcast** | Run a command on many servers at once with per-server results; dangerous commands require explicit confirmation. |
| **Workspaces** | Named workspaces remember open tabs, terminal layouts, servers, folders and pinned tools; restored on launch. |
| **AI assistant** | Bring your own Anthropic or OpenAI-compatible model (OpenAI, OpenRouter, Ollama, LM Studio…). It investigates with read-only tools; anything that changes a server is shown as the exact command and only runs after you approve it. Obvious secrets are redacted and secret files are never read. Off by default. |
| **App** | Command palette (Ctrl+K / Ctrl+Shift+P), quick server switcher (Ctrl+P), context menus everywhere, dark/light/system themes, accent colors, density, toasts + native notifications with per-type preferences, system tray, close-to-tray, start with Windows, single instance, window-state memory, signed auto-updates, MSI and EXE installers. |

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+K / Ctrl+Shift+P | Command palette |
| Ctrl+P | Quick server search |
| Ctrl+Shift+T | New terminal |
| Ctrl+Shift+F | File manager |
| Ctrl+Shift+D / Ctrl+Shift+E | Split terminal right / down |
| Ctrl+Shift+L | Local terminal |
| Ctrl+W (Ctrl+F4) / Ctrl+Shift+W | Close tab / close all tabs |
| Ctrl+Tab | Next tab |
| Ctrl+B / Ctrl+J / Ctrl+I | Sidebar / transfers panel / AI panel |
| F11 | Fullscreen |

Keys the shell needs (Ctrl+C, Ctrl+W, … inside a focused terminal) go to the shell. Saved commands can get their own shortcuts in the Command Center; the full list is in Settings → Keyboard shortcuts.

---

## Architecture

```
src-tauri/
  core/            brainbox-core — all logic, no Tauri dependency (unit + integration tested)
    ssh/           connection manager, auth, host-key gate, proxy/jump transport, exec
    terminal/      remote PTY sessions (tmux-aware) and local ConPTY shells
    sftp/          file ops (atomic save, conflict detection) and the transfer engine
    monitoring/    metrics pollers, processes, ports, services, Docker notifications
    security/      vault (AES-GCM), secrets (zeroized), command risk policy
    ai/            agent loop, read-only tools, approval queue, providers
    docker.rs git.rs logs.rs tunnels.rs broadcast.rs privileged.rs storage.rs …
  src/             the Tauri shell: ~120 typed commands, events, tray, plugins
  capabilities/    least-privilege permissions for the window
src/               React UI
  services/        typed API (generated types from Rust via ts-rs) + browser mock backend
  stores/          zustand stores (servers, workspace/tabs/panes, settings, data)
  features/        one folder per tool
e2e/               Playwright tests (UI against the mock backend)
e2e-tauri/         WebDriver test driving the real compiled app against a real sshd
```

Data lives in `%APPDATA%\com.brainbox.vps\` (SQLite database, logs). Secrets are stored only as ciphertext in that database.

---

## Getting started (Windows)

Prerequisites: [Node.js 22+](https://nodejs.org), [Rust (stable, MSVC)](https://rustup.rs), Visual Studio Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 10/11). See <https://tauri.app/start/prerequisites/>.

```powershell
npm install
npm run tauri dev          # run the app with hot reload
npm run tauri build        # build installers
```

Installers land in `src-tauri\target\release\bundle\msi\` and `…\bundle\nsis\`.

UI-only development in a browser (simulated servers, no Rust needed):

```bash
npm run dev:mock           # http://localhost:1430
```

### Auto-updates

The updater is enabled and signed. Before publishing releases:

1. Use the signing key pair that came with this project, or make your own with `npx tauri signer generate -w brainbox-updater.key` and paste the new public key into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
2. Add the private key to your GitHub repo secrets as `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if it has one). **Never commit the private key.**
3. The updater endpoint is already configured for `hamzaibnzakir/brainbox-vps`, so no endpoint edit is needed.
4. Bump `version` in `src-tauri/tauri.conf.json`, then push a matching tag, for example `git tag v0.2.0 && git push --tags`. The **Release** workflow builds signed MSI/EXE installers and `latest.json` as a draft GitHub release; publish it and installed apps will offer the update.

Windows SmartScreen will warn about unsigned installers until you add an Authenticode code-signing certificate (`bundle.windows.certificateThumbprint` or a signing command in `tauri.conf.json`).

---

## Testing

| Suite | Command | What it covers |
| --- | --- | --- |
| Rust unit tests | `cd src-tauri && cargo test -p brainbox-core` | vault, policy, parsers, SSH config import, quoting, AI tool redaction, transfer naming, … (130 tests) |
| Rust integration | `sudo bash scripts/test-sshd.sh` then `BBX_TEST_SSH=1 cargo test -p brainbox-core` | real OpenSSH server: every auth method, host-key trust/mismatch, jump host, SOCKS proxy, terminals, tmux, SFTP atomic save + conflicts, transfers with pause/resume + checksum, tunnels L/R/D, reconnect after the connection is killed, sudo, Docker, Git, logs, broadcast, AI approval flow (20 tests) |
| Frontend unit | `npm test` | formatting, paths, fuzzy search, shortcuts, language detection, terminal pane tree, error view, log severity (52 tests) |
| UI end-to-end | `npm run build:mock && npx playwright test` | add server → host-key prompt → terminal; rejected host key; readable connection errors; split + reconnect; upload, download, edit & save; Docker; create & start tunnel; command palette; AI approval |
| Real app end-to-end | `npx tauri build --no-bundle` then `node e2e-tauri/run.mjs` (Linux: needs `tauri-driver` + `WebKitWebDriver`, run under `xvfb-run`) | the compiled app against a real sshd: encrypted credential storage, fingerprint shown matches the server key, remote terminal, SFTP, editor atomic save to disk, live metrics, local terminal, no plaintext secrets on disk |

`.github/workflows/ci.yml` runs all of the above on Linux and builds the Windows installers on `windows-latest`.

---

## Security model in short

- Passwords, key passphrases, pasted private keys, proxy passwords and the AI API key are encrypted (AES-256-GCM, record-bound) before they touch disk; the master key is held by Windows Credential Manager.
- Secrets are zeroized in memory after use and are never written to logs, the UI state, crash output or AI prompts.
- Unknown host keys must be accepted by you; a changed key blocks the connection and shows both fingerprints.
- The frontend can only call the specific commands it needs; there is no open filesystem, shell or HTTP access from the UI.
- Mutating actions (kill, stop service, remove container, rm, broadcast…) are classified and confirmed; the AI can never run a mutating command without your click, and never as root unattended.

---

## Credits

Brainbox VPS is an original application. The open-source project Wrolp (MIT) was consulted as a technical reference only; no branding, design, assets or text were reused. See `NOTICE`.

License: MIT — see `LICENSE`.
