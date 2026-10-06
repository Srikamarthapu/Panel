import { test, expect } from "playwright/test";
import fs from "node:fs";
import path from "node:path";
import { mockWorkspace } from "../helpers/workspace.js";

test("startup keeps the selected companion and reports a real pending session load", async ({ page }) => {
  await mockWorkspace(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("hermes.talk.avatar", "bloub"));
  const held = [];
  await page.route("**/api/sessions", route => { held.push(route); });
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Opening your workspace" })).toBeVisible();
  await expect(page.locator("[data-startup-state=loading] .bloubAvatar")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Loading your saved sessions…");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-panel-motion", "reduced");
  await page.screenshot({ path: "/tmp/panel-startup-loading.png" });
  for (const route of held.splice(0)) await route.fallback();
  await page.unroute("**/api/sessions");
  await expect(page.locator("[data-startup-state]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
});

test("startup failure gives a focused retry that actually reloads saved sessions", async ({ page }) => {
  await mockWorkspace(page);
  let failed = true, reads = 0;
  await page.route("**/api/sessions", route => {
    reads++;
    return failed ? route.fulfill({ status: 503, json: { error: "Saved sessions are temporarily unavailable." } }) : route.fallback();
  });
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Couldn’t open your workspace" })).toBeVisible();
  await expect(page.locator("[data-startup-state=error]").getByRole("alert")).toHaveText("Saved sessions are temporarily unavailable.");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeFocused();
  await page.screenshot({ path: "/tmp/panel-startup-error.png" });
  failed = false;
  await retry.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator("[data-startup-state]")).toHaveCount(0);
});

const desktop = path.resolve("hermes-control/src");
test("desktop startup times out honestly, retries, and opens only a ready local workspace", async ({ page }) => {
  test.skip(!fs.existsSync(path.join(desktop, "index.html")), "This checkout does not ship the native wrapper.");
  await page.clock.install();
  await page.addInitScript(() => {
    window.desktopReady = false;
    window.desktopProbes = 0;
    window.__TAURI__ = { core: { invoke: async command => { if (command !== "panel_server_ready") throw new Error("Unexpected native command"); window.desktopProbes++; return window.desktopReady; } } };
  });
  await page.route("**/desktop-startup/**", route => {
    const filename = new URL(route.request().url()).pathname.split("/").pop() || "index.html";
    const contentType = filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html";
    return route.fulfill({ contentType, body: fs.readFileSync(path.join(desktop, filename), "utf8") });
  });
  await page.route("http://localhost:3000/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Workspace ready</h1>" }));
  await page.goto("/desktop-startup/");
  await expect(page.getByRole("status")).toHaveText("Connecting to your local workspace…");
  await expect(page.getByRole("button", { name: "Try connecting again" })).toBeHidden();
  await page.screenshot({ path: "/tmp/panel-native-startup-loading.png" });
  await page.clock.fastForward(30001);
  await expect(page.getByRole("heading", { name: "Panel isn’t ready yet" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("The local workspace isn’t responding.");
  await expect(page.getByRole("button", { name: "Try connecting again" })).toBeFocused();
  await page.screenshot({ path: "/tmp/panel-native-startup-error.png" });
  await page.evaluate(() => { window.desktopReady = true; });
  await page.getByRole("button", { name: "Try connecting again" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Workspace ready" })).toBeVisible();
});
