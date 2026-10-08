import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

async function modelFixture(page) {
  await mockWorkspace(page);
  const catalog = {
    ok: true, current: { provider: "deepseek", model: "deepseek-main", fallback: { provider: "remote", model: "remote-backup" } },
    voice: { provider: "deepseek", model: "deepseek-chat", usesDefault: false },
    providers: [
      { id: "nous", label: "Nous Research", configured: true, supportsCustomModel: true, models: Array.from({ length: 50 }, (_, i) => ({ id: `discovery-${i}`, source: "installed" })) },
      { id: "deepseek", label: "DeepSeek", configured: true, supportsProbe: true, supportsCustomModel: true, models: [{ id: "deepseek-main", source: "current-config" }, { id: "deepseek-chat", source: "live" }, { id: "deepseek-next", source: "live" }, { id: "old-embedding", available: false, availabilityNote: "Not a chat model." }] },
      { id: "remote", label: "Remote provider", configured: true, supportsProbe: false, supportsCustomModel: true, models: [{ id: "remote-backup", source: "config" }, { id: "remote-next", source: "live" }] },
      { id: "anthropic", label: "Anthropic", configured: false, models: [{ id: "not-connected" }] },
    ],
  };
  const requests = { assignments: [], probes: [], voiceWrites: [] };
  await page.route("**/api/models/catalog**", route => route.fulfill({ json: catalog }));
  await page.route("**/api/models/router", route => route.fulfill({ json: { configured: false, enabled: false, stats: {} } }));
  await page.route("**/api/models/switch", route => {
    const body = route.request().postDataJSON(); requests.assignments.push(body);
    if (body.role === "voice") catalog.voice = { provider: body.provider, model: body.model, usesDefault: !body.model };
    else if (body.role === "fallback") catalog.current.fallback = { provider: body.provider, model: body.model };
    else { catalog.current.provider = body.provider; catalog.current.model = body.model; }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/voice/chat", route => {
    if (route.request().method() === "PUT") { requests.voiceWrites.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 503, json: { error: "Unexpected conversation request" } });
  });
  await page.route("**/api/models/probe", route => {
    const body = route.request().postDataJSON(); requests.probes.push(body);
    const result = { ...body, ok: true, status: "available", checkedAt: new Date().toISOString(), latencyMs: 140, detail: "The provider returned a valid model response to a small test prompt." };
    catalog.providers.find(p => p.id === body.provider).models.find(m => m.id === body.model).probe = result;
    return route.fulfill({ json: { ok: true, result } });
  });
  await page.goto("/models");
  await expect(page.getByRole("heading", { name: "Your models" })).toBeVisible();
  await expect(page.locator(".modelCatalogRow")).toHaveCount(3);
  return { catalog, requests };
}
const row = (page, model) => page.locator(".modelCatalogRow").filter({ has: page.locator("strong").filter({ hasText: new RegExp(`^${model}$`) }) });

test("provider management opens the configured dashboard, explains setup, and restores keyboard focus", async ({ page }) => {
  const dashboard = "http://127.0.0.1:9119/models?profile=default";
  const opens = [];
  await page.addInitScript(() => { window.__TAURI__ = {}; });
  await page.route("**/api/models/setup", route => {
    if (route.request().method() === "POST") { opens.push(route.request().postDataJSON()); return route.fulfill({ json: { opened: true } }); }
    return route.fulfill({ json: { dashboardUrl: dashboard } });
  });
  await modelFixture(page);
  const trigger = page.getByRole("button", { name: "Manage providers", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Providers & API keys" });
  await expect(dialog).toBeVisible();
  const link = dialog.getByRole("link", { name: "Open Hermes dashboard" });
  await expect(link).toHaveAttribute("href", dashboard);
  await link.click();
  await expect(dialog.getByRole("status")).toContainText("Dashboard opened in your browser");
  expect(opens).toEqual([{ action: "open-dashboard" }]);
  await expect(dialog.locator("input[type=password]")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".sessionDialog").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("dashboard setup failure keeps a usable link and terminal fallback", async ({ page }) => {
  await page.route("**/api/models/setup", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await modelFixture(page);
  await page.getByRole("button", { name: "Manage providers", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Providers & API keys" });
  await expect(dialog.getByRole("alert")).toContainText("default port, 9119");
  await expect(dialog.getByText("hermes dashboard", { exact: true })).toBeVisible();
  await expect(dialog.getByText("hermes model", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open Hermes dashboard" })).toHaveAttribute("href", "http://127.0.0.1:9119/models?profile=default");
});

test("Models starts with current provider and saved choices without an unverified wall", async ({ page }) => {
  const { requests } = await modelFixture(page);
  await expect(page.getByRole("heading", { name: "DeepSeek", exact: true })).toBeVisible();
  await expect(page.getByText("Access unverified", { exact: true })).toHaveCount(0);
  await expect(row(page, "deepseek-main").locator(".modelAccessBadge")).toHaveText("Configured");
  await expect(row(page, "deepseek-main")).toHaveAttribute("data-selected", "true");
  await expect(page.getByText("discovery-0", { exact: true })).toHaveCount(0);
  await expect(page.getByText("old-embedding", { exact: true })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Show 1 unavailable catalog entry" }).check();
  await expect(row(page, "old-embedding").getByRole("button", { name: "Unavailable" })).toBeDisabled();
  await page.getByRole("searchbox", { name: "Search models" }).fill("next");
  await expect(page.locator(".modelCatalogRow")).toHaveCount(1);
  expect(requests.probes).toEqual([]);
  expect(requests.assignments).toEqual([]);
});

test("backup and inherited conversation choices update the intended role only", async ({ page }) => {
  const { catalog, requests } = await modelFixture(page);
  await page.getByRole("button", { name: /^Backup model / }).click();
  await expect(page.getByRole("heading", { name: "Remote provider", exact: true })).toBeVisible();
  await row(page, "remote-next").getByRole("button", { name: "Use as backup" }).click();
  await expect(row(page, "remote-next")).toHaveAttribute("data-selected", "true");
  expect(catalog.current.model).toBe("deepseek-main");
  expect(requests.assignments[0]).toEqual({ provider: "remote", model: "remote-next", role: "fallback" });
  await page.getByRole("button", { name: /^Talk & Chat / }).click();
  await page.getByRole("button", { name: "Use main model", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Talk & Chat / })).toContainText("Follow main model");
  await expect(row(page, "deepseek-main")).toContainText("Following main");
  expect(requests.assignments[1]).toEqual({ provider: "", model: "", role: "voice" });
  expect(requests.voiceWrites).toEqual([]);
});

test("an explicit access test records an exact model result without changing assignments", async ({ page }) => {
  const { requests } = await modelFixture(page);
  const model = row(page, "deepseek-main");
  await model.locator("summary").click();
  await model.getByRole("button", { name: "Test access", exact: true }).click();
  await expect(model.locator(".modelAccessBadge")).toHaveText("Configured · test passed");
  expect(requests.probes).toEqual([{ provider: "deepseek", model: "deepseek-main" }]);
  expect(requests.assignments).toEqual([]);
  await page.reload();
  await expect(row(page, "deepseek-main").locator(".modelAccessBadge")).toHaveText("Configured · test passed");
});

test("provider setup is deliberate and native providers don't expose a misleading direct test", async ({ page }) => {
  await modelFixture(page);
  await expect(page.getByRole("button", { name: /^Anthropic / })).toHaveCount(0);
  await page.locator(".modelOtherProviders summary").click();
  await page.getByRole("button", { name: /^Anthropic / }).click();
  await expect(page.getByText("Connect Anthropic", { exact: true })).toBeVisible();
  await expect(page.getByText("hermes model", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Use as / })).toHaveCount(0);
  await page.getByRole("button", { name: /^Remote provider / }).click();
  await row(page, "remote-backup").locator("summary").click();
  await expect(row(page, "remote-backup").getByRole("button", { name: "Test access" })).toHaveCount(0);
});

test("Models is accessible and usable on a narrow screen with larger text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("panel.interface.preferences", JSON.stringify({ version: 1, textSize: "larger" })));
  await modelFixture(page);
  const result = await new AxeBuilder({ page }).include(".modelWorkspaceV2").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("failed tests and rejected saves stay visible without changing current choices", async ({ page }) => {
  const { requests } = await modelFixture(page);
  await page.route("**/api/models/probe", route => route.fulfill({ json: { ok: true, result: { ok: false, detail: "The provider rejected access. Check your account permissions." } } }));
  const selected = row(page, "deepseek-main");
  await selected.locator("summary").click();
  await selected.getByRole("button", { name: "Test access" }).click();
  await expect(page.locator(".modelWorkspaceV2").getByRole("alert")).toContainText("The provider rejected access");
  await expect(selected).toHaveAttribute("data-selected", "true");
  await page.route("**/api/models/switch", route => route.fulfill({ status: 400, json: { error: "This provider could not save your choice." } }));
  await row(page, "deepseek-next").getByRole("button", { name: "Use as main" }).click();
  await expect(page.locator(".modelWorkspaceV2").getByRole("alert")).toContainText("could not save");
  await expect(selected).toHaveAttribute("data-selected", "true");
  expect(requests.assignments).toEqual([]);
});

test("an exact custom ID is validated and remains visible as the new saved assignment", async ({ page }) => {
  const { requests } = await modelFixture(page);
  await page.locator(".modelCustom summary").click();
  await page.getByRole("textbox", { name: "Model ID", exact: true }).fill("private-chat-alias");
  await page.getByRole("button", { name: "Save main model", exact: true }).click();
  await expect(row(page, "private-chat-alias")).toHaveAttribute("data-selected", "true");
  await expect(row(page, "private-chat-alias").locator(".modelAccessBadge")).toHaveText("Configured");
  expect(requests.assignments).toEqual([{ provider: "deepseek", model: "private-chat-alias", role: "primary" }]);
});

test("catalog failures preserve saved choices and offer a working retry", async ({ page }) => {
  const { catalog } = await modelFixture(page);
  let failed = true;
  await page.route("**/api/models/catalog**", route => failed ? route.fulfill({ status: 503, json: { error: "The provider catalog is temporarily unavailable." } }) : route.fulfill({ json: catalog }));
  await page.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(page.locator(".modelWorkspaceV2").getByRole("alert")).toContainText("temporarily unavailable");
  await expect(row(page, "deepseek-main")).toHaveAttribute("data-selected", "true");
  failed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".modelWorkspaceV2").getByRole("alert")).toHaveCount(0);
  await expect(row(page, "deepseek-main").locator(".modelAccessBadge")).toHaveText("Configured");
});


test("an initial catalog failure does not invent model assignments", async ({ page }) => {
  await modelFixture(page);
  await page.route("**/api/models/catalog**", route => route.fulfill({ status: 503, json: { error: "Catalog temporarily unavailable" } }));
  await page.reload();
  await expect(page.locator(".modelWorkspaceV2").getByRole("alert")).toContainText("Catalog temporarily unavailable");
  const assignments = page.locator(".modelAssignments");
  await expect(assignments.getByText("Could not load", { exact: true })).toHaveCount(3);
  await expect(assignments.getByText("Follow main model", { exact: true })).toHaveCount(0);
  await expect(assignments.getByText("Not set", { exact: true })).toHaveCount(0);
  await expect(assignments.getByText("Configured", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Connect a provider in Hermes to get started.", { exact: true })).toHaveCount(0);
});
