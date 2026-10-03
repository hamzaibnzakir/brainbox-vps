/**
 * Real-app smoke test: drives the compiled Brainbox VPS binary through
 * tauri-driver (WebDriver) against the local test sshd from scripts/test-sshd.sh.
 *
 *   bash scripts/test-sshd.sh            # sshd on 127.0.0.1:2222, user bbx / bbxpass
 *   npm run build && (cd src-tauri && cargo build --release)
 *   node e2e-tauri/run.mjs                # starts tauri-driver (needs WebKitWebDriver on Linux,
 *                                         # msedgedriver on Windows) with an isolated profile
 *
 * It exercises the real Rust backend end to end: encrypted credential storage,
 * host-key verification, the SSH terminal, SFTP listing and live metrics.
 */
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const exe = process.env.BBX_APP ?? join(root, "src-tauri/target/release", process.platform === "win32" ? "brainbox-vps.exe" : "brainbox-vps");
const driver = "http://127.0.0.1:4444";
const marker = "/tmp/bbx-real-e2e-marker";
// A file the editor test opens over SFTP (the test sshd runs on this machine as user bbx).
const editFile = process.env.BBX_EDIT_FILE ?? "/home/bbx/brainbox-e2e.txt";
if (!existsSync(exe)) throw new Error(`App binary not found: ${exe}`);
rmSync(marker, { force: true });
writeFileSync(editFile, "line one\n");
try {
  execSync(`chown bbx:bbx ${editFile}`);
} catch {}

// Isolated profile so the test never touches real user data: the app inherits
// the driver's environment, so the driver gets a throwaway HOME / XDG dirs.
const home = mkdtempSync(join(tmpdir(), "bbx-e2e-home-"));
const { spawn } = await import("node:child_process");
const { openSync } = await import("node:fs");
const logFd = openSync(process.env.BBX_DRIVER_LOG ?? join(home, "driver.log"), "w");
const driverProc = spawn("tauri-driver", [], {
  stdio: ["ignore", logFd, logFd],
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "LocalAppData"), XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache") },
});
for (let i = 0; i < 50; i++) {
  if (await fetch(driver + "/status").then(() => true, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

async function wd(method, path, body) {
  const r = await fetch(driver + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${method} ${path}: ${j.value.error}: ${j.value.message}`);
  return j.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ELEM = "element-6066-11e4-a52e-4f735466cecf";

const session = await wd("POST", "/session", {
  capabilities: { alwaysMatch: { "tauri:options": { application: exe } } },
});
const sid = session.sessionId;
const S = (p) => `/session/${sid}${p}`;
const exec = (script, args = []) => wd("POST", S("/execute/sync"), { script, args });
async function find(css, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const e = await wd("POST", S("/element"), { using: "css selector", value: css });
      return e[ELEM];
    } catch (err) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${css}: ${err.message}`);
      await sleep(250);
    }
  }
}
async function click(css) {
  const el = await find(css);
  try {
    await wd("POST", S(`/element/${el}/click`), {});
  } catch (e) {
    if (!/not interactable|intercepted/.test(e.message)) throw e;
    // Duplicate (e.g. overflow-menu) copies may come first; click the visible one.
    const ok = await exec(`const el = [...document.querySelectorAll(arguments[0])].find(e => e.offsetParent); if (el) { el.click(); return true } return false`, [css]);
    if (!ok) throw e;
  }
}
const type = async (css, text) => wd("POST", S(`/element/${await find(css)}/value`), { text });
async function clickText(text, selector = "button") {
  const ok = await exec(
    `const [sel, t] = arguments; const el = [...document.querySelectorAll(sel)].find(e => e.textContent.trim() === t && e.offsetParent); if (el) { el.click(); return true } return false`,
    [selector, text],
  );
  if (!ok) throw new Error(`No visible ${selector} with text "${text}"`);
}
async function waitFor(desc, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out: ${desc}`);
    await sleep(300);
  }
}
const bodyText = () => exec("return document.body.innerText");
const step = (s) => console.log("•", s);

let failed = false;
try {
  step("app boots to the welcome screen");
  await click('[data-testid="welcome-add-server"]');

  step("add the test server with a password (stored encrypted)");
  await type('[data-testid="server-host"]', "127.0.0.1:2222");
  const user = await find('[data-testid="server-username"]');
  await wd("POST", S(`/element/${user}/clear`), {});
  await type('[data-testid="server-username"]', "bbx");
  await type('[data-testid="server-name"]', "Local sshd");
  await clickText("Authentication");
  await type('input[placeholder="SSH password"]', "bbxpass");
  await click('[data-testid="server-save-connect"]');

  step("verify the host key on first connect");
  const fp = await waitFor("host key prompt", async () => {
    const t = await exec(`return document.querySelector('[data-testid="hostkey-fingerprint"]')?.innerText`);
    return t && t.includes("SHA256:") ? t : null;
  });
  // The fingerprint shown must be the server's real key (same format as ssh-keygen -lf).
  const { createHash } = await import("node:crypto");
  const blob = Buffer.from(readFileSync(process.env.BBX_HOST_PUB ?? "/tmp/bbx-sshd/host_2222.pub", "utf8").split(" ")[1], "base64");
  const expected = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  if (!fp.includes(expected)) throw new Error(`fingerprint mismatch: UI shows "${fp}", server key is ${expected}`);
  console.log("  fingerprint matches the server key:", expected);
  await click('[data-testid="hostkey-trust"]');

  step("terminal opens and runs commands on the real server");
  await waitFor("connected", async () => (await bodyText()).includes("Connected"));
  await find('[data-testid="terminal-pane"] .xterm-helper-textarea');
  // The remote shell may still be starting; retry until the command lands.
  for (let attempt = 0; attempt < 5 && !existsSync(marker); attempt++) {
    await sleep(1500);
    await click('[data-testid="terminal-pane"] .xterm-screen');
    await type('[data-testid="terminal-pane"] .xterm-helper-textarea', `touch ${marker}\n`);
    await waitFor("marker", async () => existsSync(marker), 3000).catch(() => {});
  }
  if (!existsSync(marker)) throw new Error("command typed in the terminal never ran on the server");

  step("SFTP lists the remote home directory");
  await click('[data-testid="tool-files"]');
  await waitFor("remote listing", async () => {
    const t = await exec(`return document.querySelector('[data-testid="file-pane-remote"]')?.innerText ?? ""`);
    return /items?/.test(t) && t.includes("/home/bbx".split("/").pop()) ? t : null;
  });

  step("edit a remote file in the editor and save it atomically");
  await waitFor("file listed", async () => exec(`return [...document.querySelectorAll('[data-testid="file-pane-remote"] *')].some(e => e.offsetParent && e.textContent.trim() === arguments[0])`, ["brainbox-e2e.txt"]));
  await exec(
    `const el = [...document.querySelectorAll('[data-testid="file-pane-remote"] *')].find(e => e.offsetParent && e.children.length === 0 && e.textContent.trim() === arguments[0]); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));`,
    ["brainbox-e2e.txt"],
  );
  await waitFor("editor loaded", async () => exec(`return document.querySelector('[data-testid="monaco-host"] .view-lines')?.textContent.replace(/\u00a0/g, ' ').includes('line one')`));
  await click('[data-testid="monaco-host"] .view-lines');
  await type('[data-testid="monaco-host"] textarea', "\uE010edited by brainbox\n");
  await waitFor("unsaved badge", async () => /unsaved/i.test(await bodyText()));
  await click('[data-testid="editor-save"]');
  await waitFor("saved to disk", async () => readFileSync(editFile, "utf8").includes("edited by brainbox"));
  if (!readFileSync(editFile, "utf8").startsWith("line one")) throw new Error("save clobbered the original content");
  const leftovers = execSync(`ls -a ${editFile.replace(/[^/]+$/, "")}`).toString();
  if (/brainbox-e2e\.txt\.(bbx|tmp)/.test(leftovers)) throw new Error("atomic save left a temp file behind");

  step("overview shows live metrics");
  await click('[data-testid="tool-overview"]');
  await waitFor("metrics", async () => {
    const t = await bodyText();
    return t.includes("CPU") && /\d+%/.test(t) && /GB|MB/.test(t);
  });

  step("local terminal runs on this computer");
  const localMarker = join(home, "local-terminal-marker");
  await click('[data-testid="open-local-terminal"]');
  for (let attempt = 0; attempt < 5 && !existsSync(localMarker); attempt++) {
    await sleep(1500);
    await click('[data-testid="terminal-pane"] .xterm-screen');
    await exec(`const t = [...document.querySelectorAll('[data-testid="terminal-pane"] .xterm-helper-textarea')].find(e => e.closest('[data-testid="terminal-pane"]').offsetParent); t && t.focus()`);
    await wd("POST", S("/actions"), { actions: [{ type: "key", id: "kb", actions: [...`echo > ${localMarker}\n`].flatMap((c) => [{ type: "keyDown", value: c === "\n" ? "\uE007" : c }, { type: "keyUp", value: c === "\n" ? "\uE007" : c }]) }] });
    await waitFor("local marker", async () => existsSync(localMarker), 3000).catch(() => {});
  }
  if (!existsSync(localMarker)) throw new Error("local terminal did not run the command");

  step("credentials are not stored in plaintext");
  const leaked = execSync(`grep -rl "bbxpass" ${home} || true`).toString().trim();
  if (leaked) throw new Error(`password found in plaintext: ${leaked}`);

  console.log("\nREAL APP E2E: PASS");
} catch (e) {
  failed = true;
  console.error("\nREAL APP E2E: FAIL —", e.message);
  try {
    console.error("--- visible text ---\n" + (await bodyText()).slice(0, 3000));
  } catch {}
  try {
    const shot = await wd("GET", S("/screenshot"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmpdir(), "bbx-real-e2e-failure.png"), Buffer.from(shot, "base64"));
    console.error("screenshot:", join(tmpdir(), "bbx-real-e2e-failure.png"));
  } catch {}
} finally {
  await wd("DELETE", S("")).catch(() => {});
  driverProc.kill();
  await sleep(500);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  rmSync(marker, { force: true });
  rmSync(editFile, { force: true });
}
process.exit(failed ? 1 : 0);
