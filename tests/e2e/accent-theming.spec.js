import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

async function appearanceFixture(page) {
  await mockWorkspace(page);
  await page.route("**/api/models/catalog**", route => route.fulfill({ json: {
    ok: true, current: { provider: "test", model: "tested-model" }, voice: { usesDefault: true },
    providers: [{ id: "test", label: "Test provider", configured: true, models: [
      { id: "tested-model", source: "current-config", probe: { ok: true } },
    ] }, { id: "other", label: "Other connected provider", configured: true, models: [{ id: "other-model" }] }],
  } }));
  await page.route("**/api/models/router", route => route.fulfill({ json: { configured: true, enabled: true, stats: {} } }));
}

const palettes = [
  { name: "Sage", key: "sage", dominant: 1 },
  { name: "Sky", key: "blue", dominant: 2 },
  { name: "Peach", key: "peach", dominant: 0 },
  { name: "Lilac", key: "lilac", dominant: 2 },
];

for (const palette of palettes) {
  test(`${palette.name} keeps surfaces neutral and colors the selected indicator`, async ({ page }) => {
    test.setTimeout(60_000);
    await appearanceFixture(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: palette.name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-panel-accent", palette.key);
    // Read actual rendered RGB, including the browser's relative-color conversion.
    const sample = await page.locator(".controlNav__link.is-current").evaluate(node => {
      const context = document.createElement("canvas").getContext("2d");
      const pixels = color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      return {
        selected: pixels(getComputedStyle(node).backgroundColor),
        text: pixels(getComputedStyle(node).color),
        indicator: pixels(getComputedStyle(node, "::before").backgroundColor),
      };
    });
    for (const neutral of [sample.selected, sample.text]) expect(Math.max(...neutral.slice(0, 3)) - Math.min(...neutral.slice(0, 3))).toBeLessThanOrEqual(1);
    expect(sample.indicator[3]).toBe(255);
    expect(sample.indicator[palette.dominant]).toBeGreaterThan(Math.min(...sample.indicator.slice(0, 3)) + 10);
    expect(sample.indicator[palette.dominant]).toBe(Math.max(...sample.indicator.slice(0, 3)));
    if (palette.key === "lilac") expect(sample.indicator[0]).toBeGreaterThan(sample.indicator[1]);
    if (palette.key === "blue") expect(sample.indicator[1]).toBeGreaterThan(sample.indicator[0]);

    for (const route of ["/settings", "/", "/chat", "/sessions", "/tasks", "/memory", "/models", "/tools", "/voice"]) {
      await page.goto(route);
      await expect(page.locator("html")).toHaveAttribute("data-panel-accent", palette.key);
      await expect(page.locator(".controlNav__link.is-current")).toBeVisible();
      if (route === "/models") {
        await expect(page.locator('.modelAccessBadge[data-state="tested"]').first()).toHaveCSS("color", "rgb(193, 232, 204)");
        await expect(page.locator('.providerConnectionDot[data-connected="true"]').first()).toHaveCSS("background-color", "rgb(168, 207, 181)");
      }
      const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(report.violations, `${palette.name} at ${route}`).toEqual([]);
    }
  });
}

test("saved accent survives hydration without temporarily resetting to Sage", async ({ page }) => {
  await appearanceFixture(page);
  await page.addInitScript(() => {
    localStorage.setItem("panel.interface.preferences", JSON.stringify({ version: 1, avatarColor: "blue" }));
    window.accentHistory = [];
    new MutationObserver(records => {
      for (const record of records) {
        if (record.target === document.documentElement) window.accentHistory.push(record.oldValue);
      }
    }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-panel-accent"] });
  });
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Sky", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-panel-accent", "blue");
  expect(await page.evaluate(() => window.accentHistory)).not.toContain("sage");
});
