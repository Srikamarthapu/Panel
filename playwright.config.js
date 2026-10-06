// playwright.config.js
// Repo root Playwright config. ESM (package.json "type": "module").
// Used by `npm run test:e2e` and `npm run test:smoke`.
import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/e2e/**/*.spec.js", "**/smoke/**/*.spec.js"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: process.env.PANEL_TEST_URL || "http://127.0.0.1:3012",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: "HERMES_NEXT_DIST_DIR=.next-test next dev -H 127.0.0.1 -p 3012",
    url: process.env.PANEL_TEST_URL || "http://127.0.0.1:3012",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
