import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

async function mockedModelRuntime(page, { messages = [] } = {}) {
  await mockWorkspace(page, { sessions: [{ id: "qa-main", name: "Model verification", messages }] });
  const state = {
    main: { provider: "nvidia", model: "nemotron-super", friendlyName: "Nemotron 3.5 Super" },
    chat: { mode: "pin", provider: "deepseek", model: "deepseek-flash", reasoningEffort: "low" },
    talk: { mode: "pin", provider: "deepseek", model: "deepseek-flash", reasoningEffort: "low" },
  };
  const requests = { patches: [], switches: [], chat: [] };
  const catalog = {
    ok: true,
    current: { provider: state.main.provider, model: state.main.model, fallback: null },
    providers: [
      { id: "nvidia", label: "NVIDIA", configured: true, supportsCustomModel: true, models: [{ id: "nemotron-super", label: "Nemotron 3.5 Super" }] },
      { id: "deepseek", label: "DeepSeek", configured: true, supportsCustomModel: true, models: [{ id: "deepseek-flash", label: "DeepSeek V4 Flash" }] },
    ],
  };
  const preferences = () => ({ version: 1, migration: "mocked-api-runtime", chat: state.chat, talk: state.talk });
  const resolution = surface => {
    const choice = state[surface];
    const pinned = choice.mode === "pin";
    const selected = pinned ? choice : state.main;
    return { surface, executionMode: "hermes", requestedProvider: selected.provider, requestedModel: selected.model, friendlyName: selected.friendlyName || (selected.model === "deepseek-flash" ? "DeepSeek V4 Flash" : "Nemotron 3.5 Super"), label: selected.friendlyName || selected.model, origin: pinned ? "surface" : "main", originLabel: pinned ? `Pinned for ${surface === "chat" ? "Chat" : "Talk"}` : "Main model", reasoningEffort: choice.reasoningEffort || "", followsMain: !pinned };
  };

  await page.unroute("**/api/models/catalog**");
  await page.unroute("**/api/models/resolution**");
  await page.unroute("**/api/voice/chat");
  await page.route("**/api/models/catalog**", route => route.fulfill({ json: catalog }));
  await page.route("**/api/models/resolution**", route => {
    const request = route.request();
    if (request.method() === "PATCH") {
      const body = request.postDataJSON(); requests.patches.push(body);
      state[body.surface] = body.mode === "pin" ? { mode: "pin", provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort || "" } : { mode: "follow-main", provider: "", model: "", reasoningEffort: "" };
      return route.fulfill({ json: { resolution: resolution(body.surface), preferences: preferences() } });
    }
    const surface = new URL(request.url()).searchParams.get("surface") === "talk" ? "talk" : "chat";
    return route.fulfill({ json: { resolution: resolution(surface), preferences: preferences() } });
  });
  await page.route("**/api/models/switch", route => {
    const body = route.request().postDataJSON(); requests.switches.push(body);
    state.main = { provider: body.provider, model: body.model, friendlyName: body.model === "nemotron-super" ? "Nemotron 3.5 Super" : body.model };
    catalog.current = { ...catalog.current, provider: body.provider, model: body.model };
    const conflict = state.chat.mode === "pin" && state.chat.model !== body.model ? [{ surface: "chat", name: "Chat", pinnedProvider: state.chat.provider, pinnedModel: state.chat.model, pinnedFriendlyName: "DeepSeek V4 Flash", mainProvider: body.provider, mainModel: body.model, mainFriendlyName: state.main.friendlyName, message: `Chat is pinned to DeepSeek V4 Flash. Switch Chat to ${state.main.friendlyName} too?` }] : [];
    return route.fulfill({ json: { ok: true, conflicts: conflict, resolutions: { chat: resolution("chat"), talk: resolution("talk") } } });
  });
  await page.route("**/api/voice/chat", route => {
    const body = route.request().postDataJSON(); requests.chat.push(body);
    return route.fulfill({ json: { response: "Synthetic mocked-runtime response." } });
  });
  return { state, requests };
}

test("mocked API runtime: Main switch prompts for a pinned Chat route and the next request uses Chat", async ({ page }) => {
  const fixture = await mockedModelRuntime(page);
  await page.goto("/chat");

  const chip = page.getByRole("button", { name: /DeepSeek V4 Flash Pinned for Chat/ });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("title", "deepseek / deepseek-flash");
  await expect(page.locator(".modelPill")).toHaveCount(0);
  await chip.click();

  const dialog = page.getByRole("dialog", { name: "Choose a model for Chat" });
  await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".modelPicker").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await dialog.getByRole("radio", { name: "Main model" }).check();
  await dialog.getByRole("button", { name: /Nemotron 3.5 Super.*Make Main/ }).click();
  await expect(dialog).toContainText("Chat is pinned to DeepSeek V4 Flash. Switch Chat to Nemotron 3.5 Super too?");
  await dialog.getByRole("button", { name: "Switch Chat too" }).click();
  await expect(dialog).toContainText("Chat now follows Main.");
  await dialog.getByRole("button", { name: "Close model picker" }).click();
  await expect(page.getByRole("button", { name: /Nemotron 3.5 Super Main model/ })).toBeVisible();

  await page.getByRole("textbox", { name: "Message Hermes" }).fill("Which route handles this?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Synthetic mocked-runtime response.", { exact: true })).toBeVisible();
  expect(fixture.requests.patches.at(-1)).toMatchObject({ surface: "chat", mode: "follow-main", sessionId: "qa-main" });
  expect(fixture.requests.chat.at(-1)).toMatchObject({ surface: "chat", audio: false });
});

test("mocked API runtime: a runtime model mismatch stays visible in the run receipt", async ({ page }) => {
  const outcome = {
    version: 1, state: "complete", finishedAt: "2026-10-18T12:00:00.000Z", execution: { active: false, stopping: false },
    summary: { text: "Completed with a provider reroute.", provenance: "agent" }, observed: { tools: [], files: [] },
    verified: { status: "unavailable", items: [], note: "No verified artifacts for this mocked browser fixture." },
    runtime: { provider: "provider-b", model: "model-b", provenance: "runtime" },
    model: { requested: { provider: "provider-a", model: "model-a" }, reported: { provider: "provider-b", model: "model-b", provenance: "runtime" }, mismatch: true },
  };
  await mockedModelRuntime(page, { messages: [{ id: "reply-with-route", role: "hermes", text: "Completed with a provider reroute.", outcome }] });
  await page.goto("/chat");
  await page.getByText("Review work", { exact: true }).click();
  const warning = page.locator(".outcomeReview__modelWarning");
  await expect(warning).toContainText("Model route changed at runtime");
  await expect(warning).toContainText("provider-a / model-a");
  await expect(warning).toContainText("provider-b / model-b");
});
