import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

function channelSpread(cssColor) {
  const channels = cssColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
  return Math.max(...channels) - Math.min(...channels);
}

test("the shell, collapsed preference, and tab data persist across workspace routes", async ({ page }) => {
  await mockWorkspace(page);
  await page.addInitScript(() => {
    window.sidebarAttributeHistory = [];
    new MutationObserver(records => {
      for (const record of records) if (record.target === document.documentElement) window.sidebarAttributeHistory.push(record.oldValue);
    }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-panel-sidebar"] });
    requestAnimationFrame(() => { window.sidebarAtFirstPaint = document.documentElement.dataset.panelSidebar || "missing"; });
  });
  let tabReads = 0;
  await page.route("**/api/workspace-tabs**", route => { tabReads += 1; return route.fulfill({ json: { tabs: [] } }); });
  await page.goto("/");

  const rail = page.getByRole("complementary", { name: "Panel sections" });
  const identity = await rail.evaluate(node => { node.dataset.testIdentity = crypto.randomUUID(); return node.dataset.testIdentity; });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(rail).toHaveClass(/is-collapsed/);

  for (const destination of ["Chat", "Tasks", "Sessions", "Agents", "Memory"]) {
    await rail.getByRole("link", { name: destination, exact: true }).click();
    await expect(rail).toHaveClass(/is-collapsed/);
    expect(await rail.getAttribute("data-test-identity")).toBe(identity);
  }
  expect(tabReads).toBe(1);

  await page.reload();
  await expect(rail).toHaveClass(/is-collapsed/);
  await expect(page.locator("html")).toHaveAttribute("data-panel-sidebar", "collapsed");
  await expect.poll(() => page.evaluate(() => window.sidebarAtFirstPaint)).toBe("collapsed");
  expect(await page.evaluate(() => window.sidebarAttributeHistory)).not.toContain("expanded");
  expect(tabReads).toBe(2);
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await page.reload();
  await expect(rail).not.toHaveClass(/is-collapsed/);
});

test("Command-B respects editable fields and modal dialogs, and collapsed links expose real tooltips", async ({ page }) => {
  await mockWorkspace(page);
  const tabsLoaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace-tabs" && response.ok());
  await page.goto("/chat");
  await tabsLoaded;
  const rail = page.getByRole("complementary", { name: "Panel sections" });

  await page.getByRole("button", { name: "Collapse sidebar" }).focus();
  await page.keyboard.press("Meta+b");
  await expect(rail).toHaveClass(/is-collapsed/);
  const tasks = rail.getByRole("link", { name: "Tasks", exact: true });
  await tasks.focus();
  const tooltipId = await tasks.getAttribute("aria-describedby");
  await expect(page.locator(`#${tooltipId}`)).toBeVisible();

  await page.getByRole("textbox", { name: "Message Hermes" }).focus();
  await page.keyboard.press("Meta+b");
  await expect(rail).toHaveClass(/is-collapsed/);
  await page.getByRole("button", { name: "Search destinations" }).click();
  await page.keyboard.press("Meta+b");
  await expect(rail).toHaveClass(/is-collapsed/);
});

test("a collapsed rail remains scrollable with many saved tabs in a short desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await mockWorkspace(page);
  const tabs = Array.from({ length: 32 }, (_, index) => ({ id: `saved-${index}`, title: `Saved ${index}`, published: index !== 31, archivedAt: null }));
  await page.route("**/api/workspace-tabs**", route => route.fulfill({ json: { tabs } }));
  const tabsLoaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace-tabs" && response.ok());
  await page.goto("/");
  await tabsLoaded;
  const rail = page.getByRole("complementary", { name: "Panel sections" });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  const dimensions = await rail.evaluate(node => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, overflowY: getComputedStyle(node).overflowY }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.overflowY).toBe("auto");

  await rail.evaluate(node => { node.scrollTop = node.scrollHeight; });
  expect(await rail.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  const lastTab = rail.getByRole("button", { name: "Continue planning Saved 31", exact: true });
  await lastTab.focus();
  const tooltipId = await lastTab.getAttribute("aria-describedby");
  const tooltip = page.locator(`#${tooltipId}`);
  await expect(tooltip).toBeVisible();
  const [railBox, tooltipBox] = await Promise.all([rail.boundingBox(), tooltip.boundingBox()]);
  expect(tooltipBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await page.evaluate(() => document.activeElement?.blur());
  await lastTab.focus();
  await expect(tooltip).toBeVisible();
  await rail.evaluate(node => { node.scrollTop = 0; });
  await expect(tooltip).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const accent of ["default", "blue"]) test(`foundational surfaces stay neutral with ${accent} accent at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockWorkspace(page);
    if (accent === "blue") await page.addInitScript(() => localStorage.setItem("panel.interface.preferences", JSON.stringify({ version: 1, avatarColor: "blue" })));
    await page.goto("/tasks");

    const colors = await page.locator(".controlNav__link.is-current").evaluate(node => ({
      page: getComputedStyle(document.body).backgroundColor,
      nav: getComputedStyle(document.querySelector(".controlNav")).backgroundColor,
      selected: getComputedStyle(node).backgroundColor,
      text: getComputedStyle(node).color,
      indicator: getComputedStyle(node, "::before").backgroundColor,
    }));
    for (const key of ["page", "nav", "selected", "text"]) expect(channelSpread(colors[key]), `${key}: ${colors[key]}`).toBeLessThanOrEqual(1);
    expect(channelSpread(colors.indicator), colors.indicator).toBeGreaterThan(20);
    await expect(page.locator("html")).toHaveAttribute("data-panel-accent", accent === "blue" ? "blue" : "sage");
  });
}
