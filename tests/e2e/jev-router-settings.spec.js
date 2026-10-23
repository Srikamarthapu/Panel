import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

const options = [
  ["discordEnabled", "Use Jev for Discord"],
  ["modelRouting", "Choose a model for default Discord and Control prompts"],
  ["toolSelection", "Choose the next tool at each step"],
  ["directDispatch", "Run ready read-only actions"],
  ["monitorProgress", "Detect repeated failures"],
  ["manageContext", "Keep useful tool context"],
];

test("Jev master off saves effective flags and restores exact preferences after reload", async ({ page }) => {
  await mockWorkspace(page);
  const savedPreferences = {
    discordEnabled: true,
    modelRouting: false,
    toolSelection: true,
    directDispatch: false,
    monitorProgress: true,
    manageContext: false,
  };
  const writes = [];
  let status = {
    enabled: true,
    ...savedPreferences,
    preferences: { ...savedPreferences },
    configured: true,
    keySource: "saved",
    keySuffix: "test",
    model: "jev-latest",
    timeoutMs: 1200,
    runtime: { installed: true, discordModelRouteInstalled: true, metrics: {}, reasons: {} },
  };
  await page.route("**/api/models/router", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: status });
    const body = route.request().postDataJSON();
    writes.push(body);
    const preferences = { ...body.preferences };
    status = {
      ...status,
      enabled: body.enabled,
      ...Object.fromEntries(options.map(([key]) => [key, body.enabled ? preferences[key] : false])),
      preferences,
    };
    return route.fulfill({ json: status });
  });

  const openJev = async () => {
    const routing = page.locator("details.modelRoutingDetails");
    if (!(await routing.evaluate(element => element.open))) await routing.locator("summary").click();
    await expect(page.getByRole("switch", { name: "Use Jev inside Hermes" })).toBeVisible();
  };
  const master = () => page.getByRole("switch", { name: "Use Jev inside Hermes" });
  const option = name => page.getByRole("checkbox", { name });

  await page.goto("/models");
  await openJev();
  await expect(master()).toBeChecked();
  for (const [key, name] of options) {
    await expect(option(name)).toBeChecked({ checked: savedPreferences[key] });
    await expect(option(name)).toBeEnabled();
  }

  await master().uncheck();
  for (const [, name] of options) {
    await expect(option(name)).not.toBeChecked();
    await expect(option(name)).toBeDisabled();
  }
  await master().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Replace TypeSafe API key")).toBeFocused();

  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Saved. Hermes will run with Jev off.", { exact: true })).toBeVisible();
  expect(writes[0]).toEqual({
    enabled: false,
    ...Object.fromEntries(options.map(([key]) => [key, false])),
    preferences: savedPreferences,
  });

  await page.reload();
  await openJev();
  await expect(master()).not.toBeChecked();
  for (const [, name] of options) {
    await expect(option(name)).not.toBeChecked();
    await expect(option(name)).toBeDisabled();
  }

  await master().check();
  for (const [key, name] of options) {
    await expect(option(name)).toBeChecked({ checked: savedPreferences[key] });
    await expect(option(name)).toBeEnabled();
  }
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(writes[1]).toEqual({ enabled: true, ...savedPreferences, preferences: savedPreferences });

  await page.reload();
  await openJev();
  await expect(master()).toBeChecked();
  for (const [key, name] of options) {
    await expect(option(name)).toBeChecked({ checked: savedPreferences[key] });
    await expect(option(name)).toBeEnabled();
  }
});
