import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E suite. Runs the real React UI against the in-browser mock backend
 * (`npm run build:mock`), which simulates servers, SSH host keys, terminals,
 * SFTP, Docker, tunnels and reconnects. The Rust backend itself is covered by
 * `cargo test` (including integration tests against a real sshd).
 */
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (process.platform === "linux" ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:4173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    launchOptions: chromiumPath && existsSync(chromiumPath) ? { executablePath: chromiumPath } : {},
  },
  webServer: {
    command: "npx vite preview --outDir dist-mock --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
