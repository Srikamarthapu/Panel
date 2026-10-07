import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

const sessions = [
  { id: "qa-alpha", name: "QA Alpha", workingDirectory: "/QA/projects/alpha", messages: [{ id: "alpha-answer", role: "hermes", text: "Alpha history stays in Alpha." }] },
  { id: "qa-beta", name: "QA Beta", messages: [{ id: "beta-answer", role: "hermes", text: "Beta history stays in Beta." }] },
];

test("chat session details restore focus, edit its folder, and create a separate session", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions });
  await page.goto("/chat");
  const details = page.getByRole("button", { name: "Session details" });
  await details.click();
  const dialog = page.getByRole("dialog", { name: "Session details" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(details).toBeFocused();

  await details.click();
  await dialog.getByRole("textbox", { name: "Session name", exact: true }).fill("QA Alpha workspace");
  await dialog.getByRole("textbox", { name: /Working folder/ }).fill("/QA/projects/alpha-v2");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QA Alpha workspace", exact: true })).toBeVisible();
  await expect(page.getByText("alpha-v2", { exact: true })).toBeVisible();
  expect(fixture.requests.sessionPatches).toContainEqual({
    id: "qa-alpha",
    patch: { name: "QA Alpha workspace", workingDirectory: "/QA/projects/alpha-v2" },
  });

  await page.getByRole("button", { name: "New session" }).click();
  const createDialog = page.getByRole("dialog", { name: "New session" });
  await createDialog.getByRole("textbox", { name: "Session name", exact: true }).fill("QA Gamma");
  await createDialog.getByRole("textbox", { name: /Working folder/ }).fill("/QA/projects/gamma");
  await createDialog.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QA Gamma", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Switch session" })).toHaveValue("qa-new-1");
  expect(fixture.requests.createdSessions).toEqual([{ name: "QA Gamma", workingDirectory: "/QA/projects/gamma" }]);
});

test("sessions can be edited, pinned, archived, and restored with their folder retained", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions });
  await page.goto("/sessions");
  await page.getByRole("button", { name: "Pin QA Beta" }).click();
  await expect(page.getByRole("button", { name: "Unpin QA Beta" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Edit QA Beta" }).click();
  const dialog = page.getByRole("dialog", { name: "Session details" });
  await dialog.getByRole("textbox", { name: "Session name", exact: true }).fill("QA Beta archive test");
  await dialog.getByRole("textbox", { name: /Working folder/ }).fill("/QA/projects/beta-archive");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  const betaRow = page.locator(".managedSession").filter({ hasText: "QA Beta archive test" });
  await expect(betaRow).toContainText("beta-archive");
  await expect(page.getByRole("button", { name: "Unpin QA Beta archive test" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Archive QA Beta archive test" }).click();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore QA Beta archive test" })).toBeVisible();
  await page.getByRole("button", { name: "Restore QA Beta archive test" }).click();
  await expect(page.getByRole("heading", { name: "No archived sessions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  const restored = page.locator(".managedSession").filter({ hasText: "QA Beta archive test" });
  await expect(restored).toContainText("beta-archive");
  await expect(page.getByRole("button", { name: "Unpin QA Beta archive test" })).toHaveAttribute("aria-pressed", "true");
  expect(fixture.requests.sessionPatches).toEqual(expect.arrayContaining([
    { id: "qa-beta", patch: { pinned: true } },
    { id: "qa-beta", patch: { name: "QA Beta archive test", workingDirectory: "/QA/projects/beta-archive" } },
    { id: "qa-beta", patch: { archived: true } },
    { id: "qa-beta", patch: { archived: false } },
  ]));
});

test("session switching stays gated until the chat request is accepted, then only Stop cancels it", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions });
  let received;
  let markReceived;
  const postReceived = new Promise(resolve => { markReceived = resolve; });
  let acceptPost;
  const acceptanceGate = new Promise(resolve => { acceptPost = resolve; });
  await page.route("**/api/voice/chat", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    received = route.request().postDataJSON();
    markReceived();
    await acceptanceGate;
    const run = {
      id: received.actionId,
      sessionId: received.sessionId,
      state: "active",
      statusLabel: "Checking the request",
      textOnly: true,
    };
    const record = fixture.records.get(received.sessionId);
    record.activeRun = run;
    record.lastRun = run;
    record.messages.push({ id: `${run.id}:user`, role: "user", text: received.text });
    return route.fulfill({ status: 202, json: { pending: true, mode: "action", actionId: run.id, statusLabel: run.statusLabel } });
  });

  await page.goto("/chat");
  await page.getByRole("textbox", { name: "Message Hermes" }).fill("Keep working while I switch sessions.");
  await page.getByRole("button", { name: "Send message" }).click();
  await postReceived;
  const picker = page.getByRole("combobox", { name: "Switch session" });
  await expect(picker).toBeDisabled();
  await expect(page.getByRole("button", { name: "New session" })).toBeDisabled();
  await page.getByRole("button", { name: "Agents" }).click();
  const agents = page.getByRole("complementary", { name: "Agent sessions" });
  const newAgent = agents.getByRole("button", { name: "New agent", exact: true });
  // Creating a profile does not switch the selected conversation or cancel it.
  await expect(newAgent).toBeEnabled();

  acceptPost();
  await expect(picker).toBeEnabled();
  await expect(page.getByRole("button", { name: "New session" })).toBeEnabled();
  await expect(newAgent).toBeEnabled();
  expect(received).toMatchObject({ sessionId: "qa-alpha", text: "Keep working while I switch sessions." });

  await newAgent.click();
  const newAgentDialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await newAgentDialog.getByRole("textbox", { name: "Agent name", exact: true }).fill("QA delegated review");
  await newAgentDialog.getByRole("textbox", { name: "SOUL.md", exact: true }).fill("Review requested changes and report verified findings.");
  await newAgentDialog.getByRole("textbox", { name: /Working folder/ }).fill("/QA/agents/review");
  await newAgentDialog.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(newAgentDialog).toBeHidden();
  await expect(picker).toHaveValue("qa-alpha");
  expect(fixture.records.get("qa-alpha").activeRun).toMatchObject({ id: received.actionId, state: "active" });
  expect(fixture.requests.stoppedRuns).toEqual([]);

  await picker.selectOption("qa-beta");
  await expect(page.getByText("Beta history stays in Beta.", { exact: true })).toBeVisible();
  const alphaAgent = page.locator(".agentsPaneCard").filter({ hasText: "QA Alpha" });
  await expect(alphaAgent.getByRole("button", { name: "Open" })).toBeEnabled();
  await alphaAgent.getByRole("button", { name: "Open" }).click();
  await expect(picker).toHaveValue("qa-alpha");
  await expect(page.getByRole("button", { name: "Stop current response" })).toBeVisible();
  expect(fixture.requests.stoppedRuns).toEqual([]);
  await alphaAgent.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop current response" })).toHaveCount(0);
  expect(fixture.requests.stoppedRuns).toEqual([{ sessionId: "qa-alpha", actionId: received.actionId }]);
  expect(fixture.records.get("qa-alpha").activeRun).toBeNull();
  expect(fixture.records.get("qa-beta").activeRun).toBeNull();
});

test("Agents opens a separate running session and stops only that session's run", async ({ page }) => {
  const alphaRun = { id: "qa-alpha-run", sessionId: "qa-alpha", state: "active", statusLabel: "Reading Alpha", textOnly: true };
  const betaRun = { id: "qa-beta-run", sessionId: "qa-beta", state: "active", statusLabel: "Reading Beta", textOnly: true };
  const fixture = await mockWorkspace(page, { sessions: [
    { ...sessions[0], activeRun: alphaRun },
    { ...sessions[1], activeRun: betaRun },
  ] });
  await page.goto("/chat");
  await page.getByRole("button", { name: "Agents" }).click();
  const pane = page.getByRole("complementary", { name: "Agent sessions" });
  const betaCard = page.locator(".agentsPaneCard").filter({ hasText: "QA Beta" });
  await expect(betaCard).toContainText("Reading Beta");
  await betaCard.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("combobox", { name: "Switch session" })).toHaveValue("qa-beta");
  await expect(page.getByText("Beta history stays in Beta.", { exact: true })).toBeVisible();
  await betaCard.getByRole("button", { name: "Stop" }).click();
  await expect(betaCard).toContainText("Stopped");
  expect(fixture.requests.stoppedRuns).toEqual([{ sessionId: "qa-beta", actionId: betaRun.id }]);
  expect(fixture.records.get("qa-alpha").activeRun).toMatchObject(alphaRun);
  expect(fixture.records.get("qa-beta").activeRun).toBeNull();
  await expect(pane).toBeVisible();
});

test("Thinking details show activity for this run and hide another agent's activity", async ({ page }) => {
  const run = { id: "qa-alpha-thinking", sessionId: "qa-alpha", state: "active", statusLabel: "Reading Alpha", textOnly: true };
  const updatedAt = new Date().toISOString();
  await mockWorkspace(page, { sessions: [{ ...sessions[0], activeRun: run }, sessions[1]] });
  await page.route("**/api/control-center", route => route.fulfill({ json: {
    model: { provider: "test", model: "test-model" },
    gateway: { online: true, running: true, state: "running", platforms: {} },
    activity: [
      { id: "alpha-current", kind: "tool", source: "hermes/tool", sessionId: "qa-alpha", runId: run.id, callId: "alpha-call", toolName: "read_file", state: "running", updatedAt },
      { id: "alpha-old-run", kind: "tool", source: "hermes/tool", sessionId: "qa-alpha", runId: "qa-alpha-old", callId: "old-call", toolName: "web_search", state: "running", updatedAt },
      { id: "beta-private", kind: "tool", source: "hermes/tool", sessionId: "qa-beta", runId: "qa-beta-run", callId: "beta-call", toolName: "terminal", state: "running", updatedAt },
      { id: "global-unrelated", kind: "tool", source: "hermes/tool", runId: "unscoped-run", callId: "global-call", toolName: "terminal", state: "running", updatedAt },
    ],
    tasks: {},
  } }));
  await page.goto("/chat");
  const details = page.locator("details.thinkingDetails");
  await expect(details).toBeVisible();
  await details.locator("summary").click();
  await expect(details.getByText("Reading context", { exact: true })).toBeVisible();
  await expect(details.getByText("Looking up information", { exact: true })).toHaveCount(0);
  await expect(details.getByText("Running a command", { exact: true })).toHaveCount(0);
});

test("narrow chat keeps session controls usable, preserves per-session drafts, and contains the Agents drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSessions = [{ ...sessions[0], name: "A long running QA agent" }, sessions[1]];
  await mockWorkspace(page, { sessions: mobileSessions });
  await page.goto("/chat");
  const picker = page.getByRole("combobox", { name: "Switch session" });
  const composer = page.getByRole("textbox", { name: "Message Hermes" });
  await expect(picker).toBeVisible();
  await expect(page.getByRole("button", { name: "New session" })).toBeInViewport();
  await page.getByRole("button", { name: "Agents" }).click();
  const agents = page.getByRole("dialog", { name: "Agent sessions" });
  await expect(agents).toBeVisible();
  await expect(agents.getByRole("button", { name: "Close agents" })).toBeInViewport();
  const agentName = agents.locator(".agentsPaneCard").getByText("A long running QA agent", { exact: true });
  const agentNameBox = await agentName.boundingBox();
  expect(agentNameBox).not.toBeNull();
  expect(agentNameBox.width).toBeGreaterThan(80);
  expect(agentNameBox.height).toBeLessThan(48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(agents).toBeHidden();

  await composer.fill("A draft for Alpha");
  await picker.selectOption("qa-beta");
  await expect(composer).toHaveValue("");
  await composer.fill("A draft for Beta");
  await picker.selectOption("qa-alpha");
  await expect(composer).toHaveValue("A draft for Alpha");
  await picker.selectOption("qa-beta");
  await expect(composer).toHaveValue("A draft for Beta");
  expect(await composer.evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
});
