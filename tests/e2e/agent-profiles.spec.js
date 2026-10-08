import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

function profileCard(page, name) {
  return page.getByRole("article", { name, exact: true });
}

async function createProfile(page, { name, color = "sage", soul, workingDirectory, provider, model }) {
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Agent name").fill(name);
  await dialog.getByLabel("Agent color").selectOption(color);
  await dialog.getByLabel("SOUL.md").fill(soul);
  await dialog.getByLabel("Working folder").fill(workingDirectory);
  await dialog.getByLabel("Provider").fill(provider);
  await dialog.getByLabel("Model ID").fill(model);
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(profileCard(page, name)).toBeVisible();
}

test("profiles save separate SOUL, folder, provider, and model; edits and archive restore persist", async ({ page }) => {
  const fixture = await mockWorkspace(page);
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  await createProfile(page, {
    name: "Atlas",
    color: "blue",
    soul: "# Atlas\n\nResearch claims from primary sources and report uncertainty.",
    workingDirectory: "/QA/work/atlas",
    provider: "provider-a",
    model: "model-a",
  });
  await createProfile(page, {
    name: "Forge",
    color: "peach",
    soul: "# Forge\n\nImplement the smallest verified change.",
    workingDirectory: "/QA/work/forge",
    provider: "provider-b",
    model: "model-b",
  });

  const atlas = [...fixture.agents.values()].find(agent => agent.name === "Atlas");
  const forge = [...fixture.agents.values()].find(agent => agent.name === "Forge");
  expect(atlas).toMatchObject({ color: "blue", soul: "# Atlas\n\nResearch claims from primary sources and report uncertainty.", workingDirectory: "/QA/work/atlas", provider: "provider-a", model: "model-a" });
  expect(forge).toMatchObject({ color: "peach", soul: "# Forge\n\nImplement the smallest verified change.", workingDirectory: "/QA/work/forge", provider: "provider-b", model: "model-b" });
  expect(atlas.sessionId).not.toBe(forge.sessionId);
  expect(atlas.workingDirectory).not.toBe(forge.workingDirectory);
  expect(atlas.soul).not.toBe(forge.soul);
  expect(fixture.records.get(atlas.sessionId).session.agentId).toBe(atlas.id);
  expect(fixture.records.get(forge.sessionId).session.agentId).toBe(forge.id);

  const atlasCard = profileCard(page, "Atlas");
  await atlasCard.getByRole("button", { name: "Edit Atlas" }).click();
  const edit = page.getByRole("dialog", { name: "Agent profile" });
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel("SOUL.md")).toHaveValue(atlas.soul);
  await expect(edit.getByLabel("Agent color")).toHaveValue("blue");
  await expect(edit.getByText(`/QA/agents/${atlas.id}/SOUL.md`, { exact: true })).toBeVisible();
  await expect(edit.getByText("/QA/work/atlas", { exact: true })).toBeVisible();
  await edit.getByLabel("Agent color").selectOption("lilac");
  await edit.getByLabel("SOUL.md").fill("# Atlas\n\nCompare primary sources and keep a concise evidence trail.");
  await edit.getByLabel("Working folder").fill("/QA/work/atlas-revised");
  await edit.getByLabel("Provider").fill("provider-b");
  await edit.getByLabel("Model ID").fill("model-a-2");
  await edit.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect(fixture.agents.get(atlas.id)).toMatchObject({
    color: "lilac",
    soul: "# Atlas\n\nCompare primary sources and keep a concise evidence trail.",
    workingDirectory: "/QA/work/atlas-revised",
    provider: "provider-b",
    model: "model-a-2",
  });

  await page.reload();
  const persisted = profileCard(page, "Atlas");
  await persisted.getByRole("button", { name: "Edit Atlas" }).click();
  const reopened = page.getByRole("dialog", { name: "Agent profile" });
  await expect(reopened.getByLabel("SOUL.md")).toHaveValue("# Atlas\n\nCompare primary sources and keep a concise evidence trail.");
  await expect(reopened.getByLabel("Agent color")).toHaveValue("lilac");
  await expect(reopened.getByLabel("Working folder")).toHaveValue("/QA/work/atlas-revised");
  await expect(reopened.getByLabel("Provider")).toHaveValue("provider-b");
  await expect(reopened.getByLabel("Model ID")).toHaveValue("model-a-2");
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();

  await persisted.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(profileCard(page, "Atlas")).toHaveCount(0);
  expect(fixture.agents.get(atlas.id).archivedAt).toBeTruthy();
  expect(fixture.records.get(atlas.sessionId).session.archivedAt).toBeTruthy();
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  const archived = profileCard(page, "Atlas");
  await expect(archived).toBeVisible();
  await archived.getByRole("button", { name: "Restore agent", exact: true }).click();
  await expect(profileCard(page, "Atlas")).toHaveCount(0);
  await page.getByRole("button", { name: "Show active", exact: true }).click();
  await expect(profileCard(page, "Atlas")).toBeVisible();
  expect(fixture.agents.get(atlas.id).archivedAt).toBeNull();
  expect(fixture.records.get(atlas.sessionId).session.archivedAt).toBeNull();
  await expect(profileCard(page, "Forge")).toBeVisible();
});

test("running a saved profile leaves the main conversation selected and opens its named composer", async ({ page }) => {
  const sessions = [
    { id: "qa-main", name: "Main conversation", messages: [{ id: "main-note", role: "hermes", text: "Main conversation history." }] },
    { id: "atlas-session", name: "Atlas conversation", agentId: "atlas", messages: [{ id: "atlas-note", role: "hermes", text: "Atlas conversation history." }] },
  ];
  const fixture = await mockWorkspace(page, { sessions, agents: [{
    id: "atlas", sessionId: "atlas-session", name: "Atlas", soul: "# Atlas\n\nResearch claims from primary sources.",
    workingDirectory: "/QA/work/atlas", provider: "provider-a", model: "model-a",
  }] });
  await page.goto("/agents");
  const card = profileCard(page, "Atlas");
  await card.getByRole("textbox", { name: "Task for Atlas" }).fill("Compare the two proposals and report the strongest evidence.");
  await card.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(card.getByText("Working", { exact: true })).toBeVisible();
  expect(fixture.requests.agentRuns).toHaveLength(1);
  expect(fixture.requests.agentRuns[0]).toMatchObject({ id: "atlas", sessionId: "atlas-session", text: "Compare the two proposals and report the strongest evidence." });
  expect(await page.evaluate(() => localStorage.getItem("panel.activeSession"))).toBe("qa-main");

  await card.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("combobox", { name: "Switch session" })).toHaveValue("atlas-session");
  await expect(page.getByRole("textbox", { name: "Message Atlas" })).toBeVisible();
  await expect(page.getByText("Atlas conversation history.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("panel.activeSession"))).toBe("atlas-session");
});

test("Talk restores only valid selected profiles and shows their real run states as Bloubs without starting work", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    localStorage.setItem("panel.selectedAgents.v1", JSON.stringify(["atlas", "missing", "forge", "atlas"]));
    localStorage.setItem("hermes.talk.avatar", "orb");
  });
  const fixture = await mockWorkspace(page, {
    sessions: [
      { id: "qa-main", name: "Main conversation" },
      { id: "atlas-session", name: "Atlas", agentId: "atlas", activeRun: { id: "atlas-run", state: "active", statusLabel: "Checking primary sources" } },
      { id: "forge-session", name: "Forge", agentId: "forge", lastRun: { id: "forge-run", state: "complete", statusLabel: "Complete" } },
    ],
    agents: [
      { id: "atlas", sessionId: "atlas-session", name: "Atlas", color: "blue", soul: "Research evidence." },
      { id: "forge", sessionId: "forge-session", name: "Forge", color: "peach", soul: "Build verified changes." },
    ],
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Talk", exact: true })).toBeVisible();
  const teammates = page.locator(".talkWorkspace__presence figure");
  await expect(teammates).toHaveCount(2);
  await expect(teammates.locator(".mcOrb--bloub")).toHaveCount(2);
  await expect.poll(() => teammates.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-companion-glow")))).toEqual(["true", "true"]);
  await expect(page.locator(".talkWorkspace__presence")).toHaveAttribute("data-companion-float", "true");
  await expect(page.locator(".talkWorkspace__presence")).toHaveAttribute("data-motion-active", "true");
  const atlasPresence = teammates.filter({ hasText: "Atlas" });
  await expect.poll(() => atlasPresence.locator('[data-bloub-role="body"]').evaluate(node => node.getBBox().width)).toBeGreaterThan(100);
  await expect(teammates.getByText("Checking primary sources", { exact: true })).toBeVisible();
  await expect.poll(() => atlasPresence.locator('svg.bloubAvatar').evaluate(svg => {
    const body = svg.querySelector('[data-bloub-role="body"]').getBBox();
    return Math.max(...[...svg.querySelectorAll('[data-bloub-role="mask-eye"]')].map(eye => eye.getBBox().height)) / body.height;
  })).toBeLessThan(.30);
  const active = fixture.records.get("atlas-session").activeRun;
  active.statusLabel = "Thinking through your request…";
  active.taskLabel = "Review the calendar integration";
  await expect(atlasPresence.getByText("Working on: Review the calendar integration", { exact: true })).toBeVisible({ timeout: 10000 });
  active.statusLabel = "Reading…";
  await expect(atlasPresence.getByText("Reading · Review the calendar integration", { exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: testInfo.outputPath("companion-progress.png") });
  await expect(teammates.getByText("Last task complete", { exact: true })).toBeVisible();
  await expect(page.locator(".talkWorkspace__presence > .talkWorkspace__caption")).toContainText("Ready when you are.");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("panel.selectedAgents.v1"))).toBe('["atlas","forge"]');
  await page.setViewportSize({ width: 390, height: 844 });
  const agentsToggle = page.getByRole("button", { name: "Agents", exact: true });
  if (await agentsToggle.getAttribute("aria-expanded") === "true") await page.getByRole("button", { name: "Close agents" }).click();
  await expect(page.locator('.talkWorkspace__presence[data-main-avatar="orb"] > .talkWorkspace__caption')).toContainText("Ready when you are.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".talkWorkspace__presence")).not.toHaveAttribute("data-companion-float", "true");
  await page.evaluate(() => {
    const next = { ...JSON.parse(localStorage.getItem("panel.interface.preferences") || "{}"), version: 1, motion: "full", companionFloat: true };
    localStorage.setItem("panel.interface.preferences", JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("panel-interface-preferences-change", { detail: next }));
  });
  await expect(page.locator(".talkWorkspace__presence")).toHaveAttribute("data-motion-active", "true");
  await expect.poll(() => teammates.first().evaluate(node => getComputedStyle(node).animationName)).toContain("companion-float");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Bloub", exact: true }).click();
  const bloubMain = page.locator('.talkWorkspace__presence[data-main-avatar="bloub"]');
  await expect(bloubMain).toBeVisible();
  await expect(bloubMain.getByRole("heading", { name: "Ready when you are.", exact: true })).toBeVisible();
  await expect(bloubMain.locator(":scope > .talkWorkspace__caption")).toContainText("Ready when you are.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(bloubMain.locator(":scope > .talkWorkspace__caption")).toBeVisible();

  if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
  const atlas = profileCard(page, "Atlas");
  const forge = profileCard(page, "Forge");
  await expect(atlas.getByRole("button", { name: "Remove Atlas from Talk" })).toHaveAttribute("aria-pressed", "true");
  await forge.getByRole("button", { name: "Remove Forge from Talk" }).click();
  await expect(teammates).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("panel.selectedAgents.v1"))).toBe('["atlas"]');
  expect(fixture.requests.agentRuns).toEqual([]);

  await forge.getByRole("button", { name: "Add Forge to Talk" }).click();
  await page.reload();
  await expect(page.locator(".talkWorkspace__presence figure")).toHaveCount(2);
  expect(fixture.requests.agentRuns).toEqual([]);
});

test("stopping a delegated child sends its own run and child IDs while leaving its sibling active", async ({ page }) => {
  const fixture = await mockWorkspace(page, { delegations: [
    { id: "child-a", runId: "parent-run", sessionId: "qa-main", name: "Research helper", task: "Check source one", status: "running", statusLabel: "Working", canStop: true },
    { id: "child-b", runId: "parent-run", sessionId: "qa-main", name: "Review helper", task: "Check source two", status: "running", statusLabel: "Working", canStop: true },
  ] });
  await page.goto("/agents");
  const research = page.getByRole("article", { name: "Research helper", exact: true });
  const review = page.getByRole("article", { name: "Review helper", exact: true });
  await expect(research).toBeVisible();
  await expect(review).toBeVisible();
  await research.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(research.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(fixture.requests.stoppedDelegations).toEqual([{ sessionId: "qa-main", runId: "parent-run", agentId: "child-a" }]);
  expect(fixture.delegations.find(agent => agent.id === "child-a").status).toBe("cancelled");
  expect(fixture.delegations.find(agent => agent.id === "child-b").status).toBe("running");
});

test("profile dialog opens by keyboard on mobile, passes axe checks, and returns focus on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockWorkspace(page);
  await page.goto("/agents");
  const trigger = page.getByRole("button", { name: "New agent", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Agent name")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const controls = dialog.locator("input:visible, textarea:visible, select:visible");
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const audit = await new AxeBuilder({ page }).include(".agentProfileDialog").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
