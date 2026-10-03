import { describe, expect, it } from "vitest";
import { languageFor } from "../languages";

describe("languageFor", () => {
  it.each([
    ["/etc/nginx/sites-available/default", "nginx"],
    ["/srv/app/.env.production", "dotenv"],
    ["Dockerfile", "dockerfile"],
    ["docker-compose.yml", "yaml"],
    ["/etc/systemd/system/app.service", "ini"],
    ["main.rs", "rust"],
    ["server.ts", "typescript"],
    ["script.py", "python"],
    ["~/.bashrc", "shell"],
  ])("%s → %s", (p, lang) => {
    expect(languageFor(p)).toBe(lang);
  });
});
