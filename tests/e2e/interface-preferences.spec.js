import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function openSettings(page) {
  await mockWorkspace(page, { sessions: [{ id: "qa-preferences", name: "Appearance test", messages: [{ id: "qa-message", role: "hermes", text: "Reading preferences change this conversation." }] }] });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Make Panel yours." })).toBeVisible();
}

test("appearance choices persist and change the actual conversation typography and spacing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSettings(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("group", { name: "Avatar", exact: true }).getByRole("button", { name: "Bloub", exact: true }).click();
  await page.getByRole("button", { name: "Sky", exact: true }).click();
  await page.getByRole("group", { name: "Avatar motion" }).getByRole("button", { name: "Reduced", exact: true }).click();
  await page.getByRole("switch", { name: "Follow cursor" }).click();
  await page.getByRole("switch", { name: "Companion glow" }).click();
  await page.getByRole("switch", { name: "Companion float" }).click();
  await page.getByRole("group", { name: "Text size" }).getByRole("button", { name: "Larger", exact: true }).click();
  await page.getByRole("group", { name: "Conversation spacing" }).getByRole("button", { name: "Compact", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-panel-motion", "reduced");
  await expect(page.locator("html")).toHaveAttribute("data-panel-text-size", "larger");
  await expect(page.locator("html")).toHaveAttribute("data-panel-conversation-spacing", "compact");
  await expect(page.locator("html")).toHaveCSS("--panel-avatar-color", "#c5daef");
  await expect(page.locator('.bloubAvatar [data-bloub-role="face"]')).toHaveAttribute("fill", "#c5daef");
  const stillEyes = await page.locator('.bloubAvatar [data-bloub-role="mask-eye"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("transform")));
  await page.mouse.move(50, 50);
  await page.waitForTimeout(100);
  expect(await page.locator('.bloubAvatar [data-bloub-role="mask-eye"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("transform")))).toEqual(stillEyes);
  await page.goto("/chat");
  await expect(page.getByText("Reading preferences change this conversation.", { exact: true })).toHaveCSS("font-size", "17px");
  await expect(page.locator(".conversationMessage")).toHaveCSS("margin-bottom", "18px");
  await page.goto("/settings");
  await expect(page.getByRole("group", { name: "Avatar", exact: true }).getByRole("button", { name: "Bloub", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Sky", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("switch", { name: "Follow cursor" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Companion glow" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Companion float" })).toHaveAttribute("aria-checked", "false");
  expect(errors).toEqual([]);
});

test("system motion updates live, an explicit choice overrides it, and reset restores the defaults", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettings(page);
  await expect(page.locator("html")).toHaveAttribute("data-panel-motion", "reduced");
  await page.getByRole("group", { name: "Avatar motion" }).getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-panel-motion", "full");
  await page.getByRole("group", { name: "Avatar motion" }).getByRole("button", { name: "System", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("html")).toHaveAttribute("data-panel-motion", "full");
  await page.getByRole("button", { name: "Lilac", exact: true }).click();
  await page.getByRole("button", { name: "Reset appearance", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sage", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Avatar", exact: true }).getByRole("button", { name: "Orb", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("switch", { name: "Follow cursor" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Companion glow" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Companion float" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("status")).toContainText("Appearance restored to the defaults.");
});

test("two windows share appearance changes while merging independent edits", async ({ page, context }) => {
  await openSettings(page);
  const other = await context.newPage();
  await openSettings(other);
  await other.getByRole("button", { name: "Peach", exact: true }).click();
  await expect(page.getByRole("button", { name: "Peach", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Text size" }).getByRole("button", { name: "Larger", exact: true }).click();
  await expect(other.getByRole("group", { name: "Text size" }).getByRole("button", { name: "Larger", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(other.getByRole("button", { name: "Peach", exact: true })).toHaveAttribute("aria-pressed", "true");
  await other.getByRole("group", { name: "Avatar", exact: true }).getByRole("button", { name: "Bloub", exact: true }).click();
  await expect(page.getByRole("group", { name: "Avatar", exact: true }).getByRole("button", { name: "Bloub", exact: true })).toHaveAttribute("aria-pressed", "true");
  await other.close();
});

test("customizing appearance keeps an accepted agent request attached to its session", async ({ page }) => {
  const run = { id: "qa-appearance-active", sessionId: "qa-appearance-work", state: "active", textOnly: true, statusLabel: "Working on the accepted request" };
  let cancellations = 0, newRequests = 0;
  await mockWorkspace(page, { sessions: [{ id: run.sessionId, name: "Work in progress", activeRun: run }] });
  await page.route("**/api/voice/runs**", route => {
    if (route.request().method() === "DELETE") cancellations++;
    return route.fulfill({ json: { run: { ...run, updatedAt: new Date().toISOString() } } });
  });
  await page.route("**/api/voice/chat", route => { newRequests++; return route.fulfill({ status: 503 }); });
  await page.goto("/settings");
  await page.getByRole("group", { name: "Avatar", exact: true }).getByRole("button", { name: "Bloub", exact: true }).click();
  await page.getByRole("group", { name: "Avatar motion" }).getByRole("button", { name: "Reduced", exact: true }).click();
  await page.getByRole("button", { name: "Peach", exact: true }).click();
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop current response", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Work in progress", exact: true })).toBeVisible();
  expect(cancellations).toBe(0);
  expect(newRequests).toBe(0);
});

test("Settings is accessible and has no overflow with larger text on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings(page);
  await page.getByRole("group", { name: "Text size" }).getByRole("button", { name: "Larger", exact: true }).click();
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const report = await new AxeBuilder({ page }).include(".preferencesPage").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(report.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
