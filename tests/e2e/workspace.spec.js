import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

const sessions = [
  { id: "qa-alpha", name: "QA Alpha", workingDirectory: "/QA/projects/alpha", messages: [{ id: "alpha-answer", role: "hermes", text: "Alpha history stays in Alpha." }] },
  { id: "qa-beta", name: "QA Beta", messages: [{ id: "beta-answer", role: "hermes", text: "Beta history stays in Beta." }] },
];
const openSessions = page => page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Sessions", exact: true }).click();

test("upgrade retains the legacy conversation ID and history without replaying import on reload", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions: [] });
  await page.addInitScript(() => {
    localStorage.setItem("hermes.voice.sessionId", "old-personal-session");
    localStorage.setItem("hermes.voice.transcript", JSON.stringify([{ id: "hermes-1", role: "hermes", text: "Your previous conversation is still here." }]));
  });
  await page.goto("/chat");
  await expect(page.getByText("Your previous conversation is still here.", { exact: true })).toBeVisible();
  expect(fixture.requests.adoptedSessions).toHaveLength(1);
  expect(fixture.requests.adoptedSessions[0].sessionId).toBe("old-personal-session");
  expect(fixture.requests.createdSessions).toHaveLength(0);
  await page.reload();
  await expect(page.getByText("Your previous conversation is still here.", { exact: true })).toBeVisible();
  expect(fixture.requests.adoptedSessions).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("hermes.voice.transcript"))).toContain("Your previous conversation is still here.");
});

test("an existing selected Panel session is not replaced by legacy browser history", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions });
  await page.addInitScript(() => {
    localStorage.setItem("panel.activeSession", "qa-beta");
    localStorage.setItem("hermes.voice.sessionId", "old-unselected-session");
    localStorage.setItem("hermes.voice.transcript", JSON.stringify([{ role: "hermes", text: "Unselected older history" }]));
  });
  await page.goto("/chat");
  await expect(page.getByText("Beta history stays in Beta.", { exact: true })).toBeVisible();
  expect(fixture.requests.adoptedSessions).toHaveLength(0);
});

test("a stale selected session still restores the previous browser conversation", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions });
  await page.addInitScript(() => {
    localStorage.setItem("panel.activeSession", "missing-session");
    localStorage.setItem("hermes.voice.sessionId", "legacy-after-stale-selection");
    localStorage.setItem("hermes.voice.transcript", JSON.stringify([{ role: "hermes", text: "History restored despite stale selection." }]));
  });
  await page.goto("/chat");
  await expect(page.getByText("History restored despite stale selection.", { exact: true })).toBeVisible();
  expect(fixture.requests.adoptedSessions).toHaveLength(1);
});

test("sessions create, select, rename, and reload with separate histories and drafts", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions });
  await page.addInitScript(() => localStorage.setItem("hermes.voice.transcript", JSON.stringify([{ id: "legacy", role: "hermes", text: "Unrelated legacy history" }])));
  await page.goto("/chat");
  await expect(page.getByText("Alpha history stays in Alpha.", { exact: true })).toBeVisible();
  await expect(page.getByText("Unrelated legacy history", { exact: true })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message Hermes" });
  await composer.fill("Unsent Alpha draft");
  await openSessions(page);
  await page.getByRole("searchbox", { name: "Search sessions" }).fill("Beta");
  await expect(page.locator(".sessionRow")).toHaveCount(1);
  await page.getByRole("button", { name: /^QA Beta / }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Beta history stays in Beta.", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpha history stays in Alpha.", { exact: true })).toHaveCount(0);
  await composer.fill("Unsent Beta draft");
  await openSessions(page);
  await page.getByRole("button", { name: /^QA Alpha / }).click();
  await expect(composer).toHaveValue("Unsent Alpha draft");
  await page.getByRole("button", { name: "Session details" }).click();
  await page.getByRole("textbox", { name: "Session name", exact: true }).fill("QA Alpha renamed");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QA Alpha renamed", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "QA Alpha renamed", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Unsent Alpha draft");
  await expect(page.getByText("Alpha history stays in Alpha.", { exact: true })).toBeVisible();
  await openSessions(page);
  await page.getByRole("button", { name: /^QA Beta / }).click();
  await expect(composer).toHaveValue("Unsent Beta draft");
  fixture.records.get("qa-alpha").messages.push({ id: "alpha-background", role: "hermes", text: "A fresh result saved while away." });
  await openSessions(page);
  await page.getByRole("button", { name: /^QA Alpha renamed / }).click();
  await expect(page.getByText("A fresh result saved while away.", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Unsent Alpha draft");
  await openSessions(page);
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByRole("textbox", { name: "Session name", exact: true }).fill("QA Gamma");
  await page.getByRole("textbox", { name: /Working folder/ }).fill("/QA/projects/gamma");
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "QA Gamma", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Where shall we start?" })).toBeVisible();
  expect(fixture.requests.createdSessions).toEqual([{ name: "QA Gamma", workingDirectory: "/QA/projects/gamma" }]);
  await openSessions(page);
  await page.getByRole("button", { name: /^QA Beta / }).click();
  await expect(composer).toHaveValue("Unsent Beta draft");
  await expect(page.getByText("Beta history stays in Beta.", { exact: true })).toBeVisible();
});

test("a restored accepted run continues while sessions switch and returns to its original conversation", async ({ page }) => {
  const run = { id: "qa-pending-run", sessionId: "qa-alpha", state: "active", statusLabel: "Reading a file", textOnly: true };
  const fixture = await mockWorkspace(page, { sessions: [{ ...sessions[0], activeRun: run }, sessions[1]] });
  let complete = false, speechRequests = 0;
  await page.route("**/api/voice/tts", route => { speechRequests++; return route.abort(); });
  await page.route("**/api/voice/runs**", route => {
    if (complete) {
      const record = fixture.records.get("qa-alpha");
      record.activeRun = null;
      record.lastRun = { ...run, state: "complete", response: "The restored request finished." };
      if (!record.messages.some(message => message.id === "pending-answer")) record.messages.push({ id: "pending-answer", role: "hermes", text: "The restored request finished." });
    }
    return route.fulfill({ json: { run: { ...run, state: complete ? "complete" : "active", response: complete ? "The restored request finished." : "", updatedAt: new Date().toISOString() } } });
  });
  await page.goto("/chat");
  const picker = page.getByRole("combobox", { name: "Switch session" });
  await expect(page.getByRole("button", { name: "Stop current response" })).toBeVisible();
  await picker.selectOption("qa-beta");
  await expect(page.getByText("Beta history stays in Beta.", { exact: true })).toBeVisible();
  expect(fixture.requests.stoppedRuns).toEqual([]);
  await picker.selectOption("qa-alpha");
  await expect(page.getByRole("button", { name: "Stop current response" })).toBeVisible();
  complete = true;
  await expect(page.getByText("The restored request finished.", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Stop current response" })).toHaveCount(0);
  expect(fixture.requests.stoppedRuns).toEqual([]);
  expect(speechRequests).toBe(0);
});

test("an interrupted run leaves thinking and shows a recoverable record after reload", async ({ page }) => {
  const run = { id: "qa-interrupted", sessionId: "qa-alpha", state: "active", textOnly: true };
  const message = "Panel lost contact with this run. Check its actions before scheduling it again.";
  const fixture = await mockWorkspace(page, { sessions: [{ ...sessions[0], activeRun: run }, sessions[1]] });
  let interrupted = false;
  await page.route("**/api/voice/runs**", route => {
    if (interrupted) {
      const record = fixture.records.get("qa-alpha");
      record.activeRun = null;
      if (!record.messages.some(item => item.id === "interrupted-record")) record.messages.push({ id: "interrupted-record", role: "hermes", isError: true, text: message });
    }
    return route.fulfill({ json: { run: { ...run, state: interrupted ? "interrupted" : "active", error: interrupted ? message : "", updatedAt: new Date().toISOString() } } });
  });
  await page.goto("/chat");
  await expect(page.getByRole("button", { name: "Stop current response" })).toBeVisible();
  interrupted = true;
  await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Stop current response" })).toHaveCount(0);
  await openSessions(page);
  await expect(page.getByRole("button", { name: /^QA Beta / })).toBeEnabled();
  await page.goto("/chat");
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText("Request interrupted", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop current response" })).toHaveCount(0);
});

test("tasks retain the requested prompt, schedule, cancellation, and result history", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions, tasks: [
    { id: "qa-completed", sessionId: "qa-beta", prompt: "Completed source check", state: "complete", response: "Three sources were checked." },
    { id: "qa-interrupted-task", sessionId: "qa-alpha", prompt: "Interrupted source check", state: "interrupted", error: "The worker stopped before this request finished." },
  ] });
  await page.goto("/tasks");
  await expect(page.getByText("Worker ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Queue a task", exact: true }).click();
  const prompt = "Read the project notes, compare the two proposals, and write a clear recommendation. Preserve the supporting links.";
  await page.getByRole("textbox", { name: "What should your agent do?" }).fill(prompt);
  await page.getByRole("combobox", { name: "Session", exact: true }).selectOption("qa-beta");
  await page.getByLabel(/Start after/).fill("2035-02-03T14:30");
  await page.getByRole("button", { name: "Add to queue", exact: true }).click();
  const queued = page.getByRole("article").filter({ has: page.getByRole("heading", { name: prompt, exact: true }) });
  await expect(queued).toBeVisible();
  expect(fixture.requests.queuedTasks).toHaveLength(1);
  expect(fixture.requests.queuedTasks[0]).toMatchObject({ prompt, sessionId: "qa-beta" });
  expect(Date.parse(fixture.requests.queuedTasks[0].runAt)).toBeGreaterThan(Date.now());
  await queued.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(queued).toHaveCount(0);
  await page.getByRole("button", { name: /^History / }).click();
  await expect(queued.getByText("Stopped", { exact: true })).toBeVisible();
  const interruptedTask = page.getByRole("article").filter({ hasText: "Interrupted source check" });
  await expect(interruptedTask.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(interruptedTask.getByText("The worker stopped before this request finished.", { exact: true })).toBeVisible();
  expect(fixture.requests.cancellations).toEqual([{ id: fixture.queue.at(-1).id, action: "cancel" }]);
  const completed = page.getByRole("article").filter({ hasText: "Completed source check" });
  await completed.getByText("Read result", { exact: true }).click();
  await expect(completed.getByText("Three sources were checked.", { exact: true })).toBeVisible();
  await completed.getByRole("button", { name: "QA Beta", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("heading", { name: "QA Beta", exact: true })).toBeVisible();
});

test("Tools renders API metadata across searchable Skills, Plugins, and Runtime views", async ({ page }) => {
  await mockWorkspace(page);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/tools");
  await expect(page.getByRole("heading", { name: "Research notebook", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search skills" }).fill("engineering");
  await expect(page.getByRole("heading", { name: "Patch review", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Research notebook", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^Plugins/ }).click();
  await expect(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Search connector", exact: true })).toBeVisible();
  await expect(page.getByText("user · v2.4.0", { exact: true })).toBeVisible();
  await expect(page.getByText("enabled", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search plugins" }).fill("missing capability");
  await expect(page.getByRole("heading", { name: "No matches", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Runtime", exact: true }).click();
  await expect(page.getByText("/QA/hermes-home", { exact: true })).toBeVisible();
  await expect(page.getByText("/QA/Hermes-runtime", { exact: true })).toBeVisible();
  await expect(page.getByText("npm run doctor", { exact: true })).toBeVisible();
  await page.goto("/tools?view=runtime");
  await expect(page.getByText("/QA/hermes-home", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("navigation exposes the workspace pages and legacy routes redirect", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/sessions");
  const sidebar = page.getByRole("complementary", { name: "Panel sections" });
  for (const name of ["Sessions", "Tasks", "Tools"]) await expect(sidebar.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of ["Projects", "Calendar", "Team", "Market", "Docs", "Visual", "Content", "System"]) await expect(sidebar.getByRole("link", { name, exact: true })).toHaveCount(0);
  for (const [legacy, destination] of [["projects", "/sessions"], ["calendar", "/tools"], ["docs", "/tools"], ["market", "/tools"], ["visual", "/tools"], ["system", "/tools"], ["team", "/tools"], ["content", "/"]]) {
    await page.goto(`/${legacy}`);
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(page.locator(".workPage, .talkWorkspace").first()).toBeVisible();
  }
});
