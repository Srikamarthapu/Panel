import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function localStatus(page) {
  await page.route("**/api/control-center", route => route.fulfill({ json: { model: { provider: "test", model: "test-model" }, gateway: { online: true, running: true, state: "running", platforms: {} }, activity: [], tasks: {} } }));
  await page.route("**/api/voice/activity**", route => route.fulfill({ json: { events: [] } }));
  await page.route("**/api/voice/status**", route => route.fulfill({ json: { status: "running", config: { autoSpeak: false, enabled: true } } }));
}
test.beforeEach(async ({ page }) => { await mockWorkspace(page); await localStatus(page); });

test("Talk renders existing avatars and shares the chosen appearance with Chat", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Talk", exact: true })).toBeVisible();
  const modes = page.getByRole("group", { name: "Voice mode" });
  await expect(modes.getByRole("button", { name: "Push to talk", exact: true })).toHaveAttribute("aria-pressed", "true");
  await modes.getByRole("button", { name: "Hands-free", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start conversation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bloub", exact: true }).click();
  await expect(page.locator(".talkWorkspace__orb .bloubAvatar")).toBeVisible();
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Where shall we start?" })).toBeVisible();
  await expect(page.locator(".chatWorkspace__presence .bloubAvatar")).toBeVisible();
});

test("keyboard navigation can open a destination through search", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Search destinations" }).click();
  await page.getByRole("textbox", { name: "Find a destination" }).fill("Chat");
  await page.getByRole("textbox", { name: "Find a destination" }).press("Enter");
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
});

test("typed turn shows pending work, a full answer, and survives reload without TTS", async ({ page }) => {
  const { records } = await mockWorkspace(page);
  let run;
  let polls = 0;
  let speechRequests = 0;
  await page.route("**/api/voice/tts", async route => { speechRequests++; await route.abort(); });
  await page.route("**/api/voice/chat", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    expect(body.audio).toBe(false);
    records.get(body.sessionId).messages.push({ id: `${body.actionId}:user`, role: "user", text: body.text });
    run = { id: body.actionId, sessionId: body.sessionId, state: "active", textOnly: true, statusLabel: "Checking the request", createdAt: new Date().toISOString() };
    await route.fulfill({ json: { pending: true, mode: "action", actionId: run.id, statusLabel: run.statusLabel } });
  });
  await page.route("**/api/voice/runs**", route => {
    const current = run ? { ...run, state: ++polls > 1 ? "complete" : "active", response: polls > 1 ? "A complete, verified test answer." : "", updatedAt: new Date().toISOString() } : null;
    if (current?.state === "complete") {
      const history = records.get(run.sessionId).messages;
      if (!history.some(item => item.id === `${run.id}:answer`)) history.push({ id: `${run.id}:answer`, role: "hermes", text: current.response });
    }
    return route.fulfill({ json: { run: current } });
  });
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message Hermes" }).fill("A harmless test question");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop current response" })).toBeVisible();
  await expect(page.getByText("A complete, verified test answer.", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Stop current response" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("A complete, verified test answer.", { exact: true })).toBeVisible();
  expect(speechRequests).toBe(0);
});

test("failed run remains visible and does not look like a completed empty answer", async ({ page }) => {
  let run;
  await page.route("**/api/voice/chat", async route => {
    const body = route.request().postDataJSON();
    run = { id: body.actionId, sessionId: body.sessionId, state: "error", textOnly: true, error: "The test provider is unavailable.", updatedAt: new Date().toISOString() };
    await route.fulfill({ json: { pending: true, mode: "action", actionId: run.id } });
  });
  await page.route("**/api/voice/runs**", route => route.fulfill({ json: { run } }));
  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message Hermes" }).fill("Test the error state");
  await page.getByRole("textbox", { name: "Message Hermes" }).press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "The test provider is unavailable." })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Stop current response" })).toHaveCount(0);
});

test("voice settings are separate from the microphone controls", async ({ page }) => {
  await page.route("**/api/voice/keys", route => route.fulfill({ json: { keys: [] } }));
  await page.route("**/api/voice/voices**", route => route.fulfill({ json: { voices: [] } }));
  await page.goto("/voice");
  await expect(page.getByRole("heading", { name: "Voice & audio", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Push to talk", exact: true })).toHaveCount(0);
});
