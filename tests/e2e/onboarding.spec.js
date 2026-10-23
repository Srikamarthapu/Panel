import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";
import { ONBOARDING_REPLAY_EVENT } from "../../lib/onboarding-state.js";

async function observeReplayListener(page) {
  await page.addInitScript(eventName => {
    const addEventListener = window.addEventListener.bind(window);
    window.__panelOnboardingReplayListenerReady = false;
    window.addEventListener = (type, listener, options) => {
      if (type === eventName) window.__panelOnboardingReplayListenerReady = true;
      return addEventListener(type, listener, options);
    };
  }, ONBOARDING_REPLAY_EVENT);
}

async function waitForReplayListener(page) {
  await page.waitForFunction(() => window.__panelOnboardingReplayListenerReady === true);
}

async function freshProfile(page) {
  await mockWorkspace(page);
  let decision = null;
  await page.route("**/api/onboarding", route => {
    if (route.request().method() === "POST") decision = { version: 1, outcome: route.request().postDataJSON().outcome, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: { decision, needsOnboarding: !decision, existingEvidence: [], hermes: { installed: true, configured: true }, storage: { panelData: "/QA/panel-data", hermesHome: "/QA/hermes-home" } } });
  });
  return () => decision;
}
test("fresh setup is optional, remembers skipping, and can be reopened from Settings", async ({ page }) => {
  const decision = await freshProfile(page);
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Your agent, ready when you are." })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Skip setup", exact: true }).click();
  expect(decision()?.outcome).toBe("skipped");
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip setup" })).toHaveCount(0);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Replay setup guide", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A quick tour of your workspace." })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Replay setup guide", exact: true })).toBeFocused();
});

test("Escape dismisses first-run setup for this launch without saving a skip", async ({ page }) => {
  const decision = await freshProfile(page);
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Your agent, ready when you are." })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  expect(decision()).toBeNull();
  await page.waitForFunction(() => !!localStorage.getItem("panel.activeSession"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your agent, ready when you are." })).toBeVisible();
});

test("a replay requested during environment loading survives the pending check", async ({ page }) => {
  await mockWorkspace(page);
  await page.unroute("**/api/onboarding");
  await observeReplayListener(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  await page.route("**/api/onboarding", async route => {
    markReadStarted();
    await gate;
    return route.fulfill({ json: {
      needsOnboarding: false,
      decision: { version: 1, outcome: "completed", updatedAt: "2026-10-15T00:00:00.000Z" },
      hermes: { installed: true, configured: true },
      storage: { panelData: "/QA/panel-data", hermesHome: "/QA/hermes-home" },
    } });
  });
  const navigation = page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Opening your workspace" })).toBeVisible();
  await readStarted;
  await waitForReplayListener(page);
  await page.evaluate(eventName => window.dispatchEvent(new CustomEvent(eventName)), ONBOARDING_REPLAY_EVENT);
  release();
  await navigation;
  await expect(page.getByRole("heading", { name: "A quick tour of your workspace." })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Hermes runtime found", { exact: true })).toBeVisible();
});

test("a replay requested while existing-user adoption is saving is not overwritten", async ({ page }) => {
  await mockWorkspace(page);
  await page.unroute("**/api/onboarding");
  await observeReplayListener(page);
  let release;
  const saveGate = new Promise(resolve => { release = resolve; });
  let markReadStarted;
  const readStarted = new Promise(resolve => { markReadStarted = resolve; });
  let markSaveStarted;
  const saveStarted = new Promise(resolve => { markSaveStarted = resolve; });
  await page.route("**/api/onboarding", async route => {
    if (route.request().method() === "POST") {
      markSaveStarted();
      await saveGate;
      return route.fulfill({ json: { decision: { version: 1, outcome: "existing-user", updatedAt: "2026-10-15T00:00:00.000Z" } } });
    }
    markReadStarted();
    return route.fulfill({ json: {
      needsOnboarding: false,
      decision: null,
      existingEvidence: ["saved-sessions"],
      hermes: { installed: true, configured: true },
      storage: { panelData: "/QA/panel-data", hermesHome: "/QA/hermes-home" },
    } });
  });
  const navigation = page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Opening your workspace" })).toBeVisible();
  await readStarted;
  await waitForReplayListener(page);
  await saveStarted;
  await page.evaluate(eventName => window.dispatchEvent(new CustomEvent(eventName)), ONBOARDING_REPLAY_EVENT);
  release();
  await navigation;
  await expect(page.getByRole("heading", { name: "A quick tour of your workspace." })).toBeVisible();
});

test("replay after continuing past a setup check error refetches the environment", async ({ page }) => {
  await mockWorkspace(page);
  await page.unroute("**/api/onboarding");
  let unavailable = true;
  await page.route("**/api/onboarding", route => {
    if (unavailable) return route.fulfill({ status: 503, json: { error: "Setup check unavailable." } });
    return route.fulfill({ json: {
      needsOnboarding: false,
      decision: { version: 1, outcome: "completed", updatedAt: "2026-10-15T00:00:00.000Z" },
      hermes: { installed: true, configured: true },
      storage: { panelData: "/QA/panel-data", hermesHome: "/QA/hermes-home" },
    } });
  });
  await page.goto("/settings");
  const startup = page.locator("[data-startup-state=error]");
  await expect(startup.getByRole("alert")).toHaveText("Setup check unavailable.");
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(page.getByRole("heading", { name: "Choose how Panel answers." })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Replay setup guide", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A quick tour of your workspace." })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Hermes runtime found", { exact: true })).toBeVisible();
});

test("a malformed successful setup response stays recoverable instead of claiming Hermes is missing", async ({ page }) => {
  await mockWorkspace(page);
  await page.unroute("**/api/onboarding");
  await page.route("**/api/onboarding", route => route.fulfill({ json: {} }));
  await page.goto("/settings");
  await expect(page.locator("[data-startup-state=error]").getByRole("alert")).toHaveText("Panel returned an incomplete setup status. Try again.");
  await expect(page.getByText("Hermes runtime was not found in the expected local installation", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue to workspace" })).toBeVisible();
});

test("first-run guide shows real check failures and local paths and can finish without voice", async ({ page }) => {
  await freshProfile(page);
  await page.route("**/api/models/catalog**", route => route.fulfill({ status: 503, json: { error: "Provider catalog is temporarily unavailable." } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Provider catalog is temporarily unavailable.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Voice needs more local setup", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("/QA/panel-data", { exact: true })).toBeVisible();
  await expect(page.getByText("/QA/hermes-home", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Talk", exact: true })).toBeVisible();
});

test("fresh Hermes-free setup opens direct connection settings only after saving the skipped guide", async ({ page }) => {
  await mockWorkspace(page);
  await page.unroute("**/api/onboarding");
  const writes = [];
  let saveAttempts = 0;
  let directWrites = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/direct/config" && request.method() === "PUT") directWrites++;
  });
  await page.route("**/api/onboarding", route => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON());
      saveAttempts++;
      if (saveAttempts === 1) return route.fulfill({ status: 503, json: { error: "Setup decision could not be saved." } });
      return route.fulfill({ json: { decision: { version: 1, outcome: "skipped", updatedAt: new Date().toISOString() }, needsOnboarding: false } });
    }
    return route.fulfill({ json: {
      decision: null, needsOnboarding: true, existingEvidence: [],
      hermes: { installed: false, configured: false },
      direct: { executionMode: "hermes", provider: "", model: "", ready: false },
      storage: { panelData: "/QA/panel-data", hermesHome: "/QA/missing-hermes-home" },
    } });
  });

  await page.goto("/chat");
  const connect = page.getByRole("button", { name: "Connect an API key", exact: true });
  await expect(connect).toBeVisible();
  await connect.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Setup decision could not be saved.");
  await expect(page.getByRole("heading", { name: "Your agent, ready when you are." })).toBeVisible();
  await expect(page).toHaveURL(/\/chat$/);

  await connect.click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Choose how Panel answers." })).toBeVisible();
  await expect(page.getByLabel("API key")).toBeVisible();
  expect(writes).toEqual([{ outcome: "skipped" }, { outcome: "skipped" }]);
  expect(directWrites).toBe(0);
});
