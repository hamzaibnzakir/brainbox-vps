import { expect, type Page } from "@playwright/test";

export async function boot(page: Page, query = "") {
  await page.goto("/" + query);
  await expect(page.locator('[data-server-id="srv-prod"]').or(page.getByTestId("welcome-add-server"))).toBeVisible();
}

/** Text of every terminal buffer (exposed by mock builds only). */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => Object.values((window as unknown as { __bbxTerminals: () => Record<string, string> }).__bbxTerminals()).join("\n"));
}

export async function expectTerminal(page: Page, text: string | RegExp) {
  await expect.poll(() => terminalText(page), { timeout: 8000 }).toMatch(typeof text === "string" ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : text);
}

export async function openServer(page: Page, id = "srv-prod") {
  await page.locator(`[data-server-id="${id}"]`).dblclick();
  await expect(page.getByTestId("server-header")).toBeVisible();
}

export async function typeInTerminal(page: Page, text: string) {
  await page.locator('[data-testid="terminal-pane"]:visible').last().click();
  await page.keyboard.type(text);
}
