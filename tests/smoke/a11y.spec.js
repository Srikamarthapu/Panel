import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

test.beforeEach(async ({ page }) => mockWorkspace(page));

for (const route of ["/", "/chat", "/sessions", "/tasks", "/tools"]) {
  test(`accessible shell and contrast at ${route}`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator(".controlShell")).toBeVisible();
    if (route === "/sessions") await page.getByRole("button", { name: "New session", exact: true }).click();
    if (route === "/tasks") await page.getByRole("button", { name: "Queue a task", exact: true }).click();
    if (route === "/tools") await page.getByRole("button", { name: "Runtime", exact: true }).click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("keyboard focus remains visible on the primary voice control", async ({ page }) => {
  await page.goto("/");
  const button = page.locator(".voiceDock__hold");
  await button.focus();
  const width = await button.evaluate(el => parseFloat(getComputedStyle(el).outlineWidth));
  expect(width).toBeGreaterThanOrEqual(2);
});

for (const route of ["/sessions", "/tasks", "/tools"]) {
  test(`workspace fits a narrow screen at ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(route);
    await expect(page.locator(".workPage")).toBeVisible();
    if (route === "/sessions") await page.getByRole("button", { name: "New session", exact: true }).click();
    if (route === "/tasks") await page.getByRole("button", { name: "Queue a task", exact: true }).click();
    if (route === "/tools") await page.getByRole("button", { name: "Runtime", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const controls = page.locator(".workPage input:visible, .workPage textarea:visible, .workPage select:visible");
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
  });
}

test("chat fits a narrow screen and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeEditable();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".conversationHistory").evaluate(el => getComputedStyle(el).scrollBehavior)).toBe("auto");
});
