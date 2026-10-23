import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

const providerRows = configured => [
  { id: "openai", label: "OpenAI", configured: configured.openai, keySource: configured.openai ? "saved" : null },
  { id: "openrouter", label: "OpenRouter", configured: configured.openrouter, keySource: configured.openrouter ? "saved" : null },
  { id: "deepseek", label: "DeepSeek", configured: configured.deepseek, keySource: configured.deepseek ? "saved" : null },
];

test("direct Settings stages credentials separately from the active route and labels Chat truthfully", async ({ page }) => {
  await mockWorkspace(page);
  await page.unroute("**/api/direct/config");
  await page.unroute("**/api/control-center");
  await page.unroute("**/api/models/resolution**");

  const configured = { openai: false, openrouter: false, deepseek: false };
  const writes = [], publicResponses = [], catalogRequests = [];
  const secrets = ["sk-browser-openai", "sk-browser-deepseek"];
  const state = { executionMode: "hermes", provider: "", model: "", ready: false };
  const publicConfig = () => ({ ...state, providers: providerRows(configured) });
  const modelPreferences = { version: 1, migration: "mocked-api-runtime", chat: { mode: "follow-main", provider: "", model: "", reasoningEffort: "" }, talk: { mode: "follow-main", provider: "", model: "", reasoningEffort: "" } };
  await page.route("**/api/direct/config", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON(); writes.push(body);
      if (body.apiKey) configured[body.credentialProvider] = true;
      if (body.clearKey) configured[body.credentialProvider] = false;
      if (Object.hasOwn(body, "provider")) state.provider = body.provider;
      if (Object.hasOwn(body, "model")) state.model = body.model;
      if (Object.hasOwn(body, "executionMode")) state.executionMode = body.executionMode;
      state.ready = Boolean(state.provider && state.model && configured[state.provider]);
    }
    const response = { config: publicConfig() };
    publicResponses.push(JSON.stringify(response));
    return route.fulfill({ json: response });
  });
  await page.route("**/api/direct/models**", route => {
    const provider = new URL(route.request().url()).searchParams.get("provider");
    catalogRequests.push(provider);
    const id = provider === "deepseek" ? "deepseek-provider-model" : "openai-provider-model";
    return route.fulfill({ json: { provider, models: [{ id, label: id }] } });
  });
  await page.route("**/api/control-center", route => route.fulfill({ json: {
    runtime: { available: state.executionMode === "direct" && state.ready, mode: state.executionMode, ...(state.executionMode === "direct" ? { provider: state.provider, model: state.model } : {}) },
    model: state.executionMode === "direct" ? { provider: state.provider, model: state.model } : { provider: "test", model: "hermes-model" },
    gateway: { online: false, running: false, state: "stopped", platforms: {} }, activity: [], tasks: {},
  } }));
  await page.route("**/api/models/resolution**", route => {
    const surface = new URL(route.request().url()).searchParams.get("surface") === "talk" ? "talk" : "chat";
    if (route.request().method() === "PATCH" && state.executionMode === "direct") return route.fulfill({ status: 409, json: { error: "Direct API settings control this route." } });
    const direct = state.executionMode === "direct" && state.ready;
    return route.fulfill({ json: {
      resolution: { surface, executionMode: direct ? "direct" : "hermes", requestedProvider: direct ? state.provider : "test", requestedModel: direct ? state.model : "test-model", friendlyName: direct ? state.model : "test-model", label: direct ? state.model : "test-model", origin: direct ? "direct" : "main", originLabel: direct ? "Direct API" : "Main model", reasoningEffort: "", followsMain: !direct },
      preferences: modelPreferences,
    } });
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Choose how Panel answers." })).toBeVisible();
  const desktopGeometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const provider = box("#direct-provider"), apiKey = box("#direct-api-key"), save = box(".directConnection__form .workButton");
    const model = box("#direct-model"), modelHelp = box("#direct-model-help");
    return {
      heights: [provider.height, apiKey.height, save.height, model.height],
      credentialTops: [provider.top, apiKey.top, save.top],
      modelHelpBelowField: modelHelp.top > model.bottom && Math.abs(modelHelp.left - model.left) < 1,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(Math.max(...desktopGeometry.heights) - Math.min(...desktopGeometry.heights)).toBeLessThan(1);
  expect(Math.max(...desktopGeometry.credentialTops) - Math.min(...desktopGeometry.credentialTops)).toBeLessThan(1);
  expect(desktopGeometry.modelHelpBelowField).toBe(true);
  expect(desktopGeometry.overflow).toBe(0);
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("openai");
  await page.getByLabel("API key").fill(secrets[0]);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Loaded 1 models from the provider.")).toBeVisible();
  expect(catalogRequests).toEqual(["openai"]);
  expect(state).toMatchObject({ executionMode: "hermes", provider: "", model: "" });

  await page.getByLabel("Model ID").fill("openai-provider-model");
  await page.getByRole("button", { name: "Use this model" }).click();
  await expect(page.getByText("This direct model will handle new requests.")).toBeVisible();
  expect(state).toMatchObject({ executionMode: "direct", provider: "openai", model: "openai-provider-model", ready: true });

  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.locator(".localPill")).toContainText("Direct API");
  await expect(page.locator(".modelPill")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /openai-provider-model Direct API/ })).toHaveAttribute("title", "openai / openai-provider-model");
  await expect(page.getByRole("textbox", { name: "Message Direct assistant" })).toBeVisible();

  await page.getByRole("navigation", { name: "Agent settings" }).getByRole("link", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: /^Chat / }).click();
  await expect(page.getByRole("link", { name: "Open Direct API settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Provider A / }).click();
  await expect(page.getByRole("button", { name: "Managed elsewhere" }).first()).toBeDisabled();

  await page.getByRole("navigation", { name: "Agent settings" }).getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("deepseek");
  await page.getByLabel("API key").fill(secrets[1]);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Loaded 1 models from the provider.")).toBeVisible();
  expect(state).toMatchObject({ executionMode: "direct", provider: "openai", model: "openai-provider-model", ready: true });
  expect(writes.at(-1)).toEqual({ credentialProvider: "deepseek", apiKey: secrets[1] });

  await page.getByRole("button", { name: "Remove key" }).click();
  expect(writes.at(-1)).toEqual({ credentialProvider: "deepseek", clearKey: true });
  expect(state).toMatchObject({ executionMode: "direct", provider: "openai", model: "openai-provider-model", ready: true });
  expect(publicResponses.every(response => secrets.every(secret => !response.includes(secret)))).toBe(true);
  expect(await page.evaluate(values => values.every(value => !JSON.stringify(localStorage).includes(value)), secrets)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileGeometry = await page.evaluate(() => {
    const provider = document.querySelector("#direct-provider").getBoundingClientRect();
    const apiKey = document.querySelector("#direct-api-key").getBoundingClientRect();
    const save = document.querySelector(".directConnection__form .workButton").getBoundingClientRect();
    return {
      equalWidths: Math.max(provider.width, apiKey.width, save.width) - Math.min(provider.width, apiKey.width, save.width) < 1,
      stacked: provider.bottom < apiKey.top && apiKey.bottom < save.top,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(mobileGeometry).toEqual({ equalWidths: true, stacked: true, overflow: 0 });
});

test("a fresh direct profile reaches onboarding without a Hermes installation", async ({ page }) => {
  const direct = {
    executionMode: "direct", provider: "deepseek", model: "provider-returned-model", ready: true,
    providers: providerRows({ openai: false, openrouter: false, deepseek: true }),
  };
  await mockWorkspace(page, { directConfig: direct });
  await page.unroute("**/api/onboarding");
  let modelCatalogRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/models/catalog") modelCatalogRequests++; });
  await page.route("**/api/onboarding", route => route.fulfill({ json: {
    decision: null, needsOnboarding: true, existingEvidence: ["direct-provider"],
    hermes: { installed: false, configured: false }, direct,
    storage: { panelData: "/QA/panel-data", hermesHome: "/QA/missing-hermes-home" },
  } }));

  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Your agent, ready when you are." })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Direct API mode is ready." })).toBeVisible();
  await expect(page.getByText("Direct provider and model configured", { exact: true })).toBeVisible();
  await expect(page.getByText(/Hermes runtime was not found/)).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your direct model is selected." })).toBeVisible();
  await expect(page.getByText("deepseek / provider-returned-model", { exact: true })).toBeVisible();
  expect(modelCatalogRequests).toBe(0);
});
