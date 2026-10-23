// playwright.config.js
// Repo root Playwright config. ESM (package.json "type": "module").
// Used by `npm run test:e2e` and `npm run test:smoke`.
import { defineConfig } from "playwright/test";

const externalUrl = String(process.env.PANEL_TEST_URL || "").trim();
const localPort = Number(process.env.PANEL_TEST_PORT || 3012);
if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw new Error("PANEL_TEST_PORT must be a valid unprivileged port.");
const localUrl = `http://127.0.0.1:${localPort}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/e2e/**/*.spec.js", "**/smoke/**/*.spec.js"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: externalUrl || localUrl,
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: externalUrl ? undefined : {
    command: "node scripts/test-browser-server.mjs",
    url: localUrl,
    reuseExistingServer: false,
    timeout: 240_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
