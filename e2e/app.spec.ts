import { expect, test } from "@playwright/test";
import { boot, expectTerminal, openServer, typeInTerminal } from "./helpers";

test.describe("servers", () => {
  test("add a server, verify its host key and land in a terminal", async ({ page }) => {
    await boot(page, "?empty");
    await page.getByTestId("welcome-add-server").click();
    await page.getByTestId("server-host").fill("deploy@203.0.113.50:2200");
    await expect(page.getByTestId("server-username")).toHaveValue("deploy");
    await page.getByTestId("server-name").fill("Staging");
    await page.getByRole("button", { name: "Authentication" }).click();
    await page.getByPlaceholder(/password/i).first().fill("s3cret");
    await page.getByTestId("server-save-connect").click();

    // First connection: the host key must be verified by the user.
    await expect(page.getByTestId("hostkey-fingerprint")).toContainText("SHA256:");
    await page.getByTestId("hostkey-trust").click();

    await expect(page.locator('[data-server-id]').filter({ hasText: "Staging" })).toBeVisible();
    await expect(page.getByTestId("terminal-pane").first()).toBeVisible();
    await typeInTerminal(page, "whoami\r");
    await expectTerminal(page, /\ndeploy/);
  });

  test("rejecting an unknown host key does not connect", async ({ page }) => {
    await boot(page);
    await page.locator('[data-server-id="srv-dev"]').dblclick();
    await page.getByTestId("hostkey-reject").click();
    await expect(page.locator('[data-server-id="srv-dev"]')).toContainText(/cancel/i);
  });

  test("connection errors are explained in plain language", async ({ page }) => {
    await boot(page);
    // srv-old lives outside the current workspace, so widen the list first.
    await page.getByRole("button", { name: "Show all" }).click();
    await page.locator('[data-server-id="srv-old"]').dblclick();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("alert").first()).toContainText(/refused/i);
    await page.getByRole("button", { name: /technical details/i }).first().click();
  });
});

test.describe("terminal", () => {
  test("runs commands, splits panes and survives a reconnect", async ({ page }) => {
    await boot(page);
    await openServer(page);
    await typeInTerminal(page, "echo hello-brainbox\r");
    await expectTerminal(page, "hello-brainbox");

    await page.keyboard.press("Control+Shift+D");
    await expect(page.getByTestId("terminal-pane")).toHaveCount(2);

    await page.evaluate(() => (window as unknown as { __bbxMock: { drop: (id: string) => void } }).__bbxMock.drop("srv-prod"));
    await expect(page.getByTestId("server-header")).toContainText(/reconnecting/i);
    await expect(page.getByTestId("server-header")).toContainText(/connected/i, { timeout: 10_000 });
    await expectTerminal(page, "reattached to tmux session");
    await typeInTerminal(page, "pwd\r");
    await expectTerminal(page, "/home/deploy");
  });
});

test.describe("files", () => {
  test("upload, download and edit a remote file", async ({ page }) => {
    await boot(page);
    await openServer(page);
    await page.getByTestId("tool-files").click();
    const remote = page.getByTestId("file-pane-remote");
    await expect(remote.getByText("deploy.sh")).toBeVisible();

    // Upload (the browser build stands in a prompt for the native file picker)
    page.once("dialog", (d) => void d.accept("C:\\Users\\David\\Documents\\notes.md"));
    await page.getByRole("button", { name: "Upload files" }).click();
    await expect(remote.getByText("notes.md")).toBeVisible({ timeout: 15_000 });

    // Download via F5 with the remote file selected
    await remote.getByText("deploy.sh").click();
    await page.keyboard.press("F5");
    await expect(page.getByTestId("transfer-row").filter({ hasText: "deploy.sh" })).toContainText("Done", { timeout: 15_000 });
    await expect(page.getByTestId("file-pane-local").getByText("deploy.sh")).toBeVisible();

    // Edit and save atomically
    await remote.getByText("deploy.sh").dblclick();
    const editor = page.getByTestId("monaco-host");
    await expect(editor.locator(".view-lines")).toContainText("pm2 restart shop");
    await editor.locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\necho e2e-edit");
    await expect(page.getByText("Unsaved")).toBeVisible();
    await page.keyboard.press("Control+S");
    await expect(page.getByText("Saved deploy.sh")).toBeVisible();
    await expect(page.getByText("Unsaved")).toHaveCount(0);

    await page.getByTestId("tool-terminal").click();
    await typeInTerminal(page, "cat deploy.sh\r");
    await expectTerminal(page, "echo e2e-edit");
  });
});

test.describe("tools", () => {
  test("docker containers are listed", async ({ page }) => {
    await boot(page);
    await openServer(page);
    await page.getByTestId("tool-docker").click();
    await expect(page.getByText("shop-web-1").first()).toBeVisible();
    await expect(page.getByText("shop-redis-1").first()).toBeVisible();
  });

  test("create and start a local tunnel", async ({ page }) => {
    await boot(page);
    await openServer(page);
    await page.getByTestId("tool-tunnels").click();
    await page.getByTestId("new-tunnel").click();
    await page.getByPlaceholder("e.g. Postgres").fill("E2E Postgres");
    await page.getByPlaceholder("5433").fill("15432");
    await page.getByPlaceholder("5432").fill("5432");
    await page.getByTestId("tunnel-save").click();
    const card = page.getByTestId("tunnel-card").filter({ hasText: "E2E Postgres" });
    await expect(card).toBeVisible();
    await card.getByTestId("tunnel-start").click();
    await expect(card).toContainText(/running/i);
  });

  test("command palette finds and runs actions", async ({ page }) => {
    await boot(page);
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill("settings");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tab-settings")).toBeVisible();
    await page.keyboard.press("Control+K");
    await page.getByTestId("palette-input").fill("database");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("server-header")).toContainText("Database VPS");
  });

  test("AI proposals require explicit approval", async ({ page }) => {
    await boot(page);
    await openServer(page);
    await page.getByTitle(/^Settings/).first().click().catch(async () => page.getByLabel(/^Settings/).first().click());
    await page.getByTestId("settings-ai").click();
    await page.getByRole("switch").first().click();
    await page.locator('input[type="password"]').first().fill("sk-test");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByTestId("toggle-ai").click();
    await page.getByTestId("ai-input").fill("Free up memory");
    await page.keyboard.press("Enter");
    const proposal = page.getByTestId("ai-proposal");
    await expect(proposal).toBeVisible({ timeout: 10_000 });
    await expect(proposal).toContainText(/changes server/i);
    await page.getByTestId("ai-approve").click();
    await expect(proposal).not.toContainText("Approve & run", { timeout: 10_000 });
  });
});
