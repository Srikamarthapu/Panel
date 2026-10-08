import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

const plan = { title: "Reading desk", outcome: "Track the books I want to read.", features: ["Editable reading list", "Notes for each reading session"], connections: [], boundaries: ["Local entries only"], checks: ["Entries survive reopening the tab"] };
async function tabsFixture(page, { offerPlan = true } = {}) {
  await mockWorkspace(page);
  let tab = null, run = null, messages = [], state = {}, actions = [];
  await page.route("**/api/workspace-tabs**", route => {
    const url = new URL(route.request().url()), method = route.request().method();
    const parts = url.pathname.split("/").filter(Boolean);
    const body = method === "GET" ? {} : route.request().postDataJSON();
    if (parts.length === 2) {
      if (method === "POST") tab ||= { id: body.id, title: "New tab", sessionId: "qa-plan", executionSessionId: "qa-execute", phase: "planning", storagePath: "/QA/tabs/reading", previewVersion: null, publishedVersion: null, archivedAt: null };
      return route.fulfill({ json: method === "POST" ? { tab } : { tabs: tab ? [{ ...tab, published: !!tab.publishedVersion }] : [] } });
    }
    if (parts[3] === "state") { if (method === "PUT") state = body.value; return route.fulfill({ json: method === "PUT" ? { saved: true } : { value: state } }); }
    if (parts[3] === "artifact") return route.fulfill({ json: { version: "version-1", spec: { title: "Reading desk", description: "Your local reading list.", blocks: [{ id: "notes", type: "notes", label: "Reading notes", title: "Notes" }] } } });
    if (method === "PATCH") { tab.archivedAt = body.archived ? new Date().toISOString() : null; return route.fulfill({ json: { tab } }); }
    if (method === "POST") {
      actions.push(body);
      if (body.action === "message") {
        messages.push({ id: `${body.requestId}:user`, runId: body.requestId, role: "user", text: body.text });
        const ready = messages.filter(item => item.role === "user").length >= 2;
        const answer = ready ? "Here is the plan we discussed. Review it below." : "Should this be a personal reading list, or a shared one?";
        messages.push({ id: `${body.requestId}:answer`, runId: body.requestId, role: "hermes", text: answer });
        if (ready && offerPlan) { tab.suggestedPlan = plan; tab.planDigest = "reviewed-plan"; }
        run = { id: body.requestId, sessionId: tab.sessionId, state: "complete", response: answer };
      }
      if (body.action === "plan") { tab.suggestedPlan = plan; tab.planDigest = "reviewed-plan"; }
      if (body.action === "build") { expect(body.planDigest).toBe("reviewed-plan"); tab = { ...tab, title: plan.title, phase: "preview", previewVersion: "version-1" }; }
      if (body.action === "publish") { expect(body.version).toBe("version-1"); tab = { ...tab, phase: "published", publishedVersion: body.version }; }
      return route.fulfill({ json: { run, tab } });
    }
    return route.fulfill({ json: { tab, messages, run } });
  });
  return { actions, get tab() { return tab; } };
}

test("workspace plus discusses requirements, reviews the plan, previews and explicitly adds a tab", async ({ page }) => {
  const fixture = await tabsFixture(page);
  await page.goto("/chat");
  await page.getByRole("button", { name: "Create a workspace tab" }).click();
  const dialog = page.getByRole("dialog", { name: "Make a tab with Hermes" });
  await expect(dialog).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Hermes about your tab" });
  await input.fill("I want a reading desk."); await input.press("Enter");
  await expect(page.getByText("Should this be a personal reading list, or a shared one?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Build this preview" })).toHaveCount(0);
  await input.fill("Personal, local only; a reading list and notes."); await input.press("Enter");
  await expect(page.getByRole("region", { name: "Plan to review" })).toBeVisible();
  expect(fixture.actions.filter(item => item.action === "build")).toHaveLength(0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(axe.violations).toEqual([]);
  await page.getByRole("button", { name: "Build this preview" }).click();
  await page.getByRole("button", { name: "Open preview" }).click();
  await expect(page.getByRole("textbox", { name: "Reading notes" })).toBeVisible();
  expect(fixture.actions.filter(item => item.action === "publish")).toHaveLength(0);
  await page.getByRole("button", { name: "Add to workspace", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${fixture.tab.id}$`));
  await expect(page.getByRole("link", { name: "Reading desk", exact: true })).toBeVisible();
  expect(fixture.actions.map(item => item.action)).toEqual(["message", "message", "build", "publish"]);
});

test("draft resumes after closing, archive is reversible, and planner fits a narrow screen", async ({ page }) => {
  await tabsFixture(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/chat");
  await page.getByText("Configuration", { exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Mobile configuration" }).getByRole("link", { name: "Models", exact: true })).toBeVisible();
  const create = page.getByRole("button", { name: "Create a workspace tab" });
  await create.click();
  await page.getByRole("textbox", { name: "Message Hermes about your tab" }).fill("Help me design a desk.");
  await page.getByRole("button", { name: "Send tab idea" }).click();
  await expect(page.getByText("Should this be a personal reading list, or a shared one?")).toBeVisible();
  await page.getByRole("button", { name: "Close tab planner" }).click();
  await expect(create).toBeFocused();
  await page.getByRole("button", { name: "New tab Draft" }).click();
  await expect(page.getByText("Help me design a desk.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Archive tab", exact: true }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore tab" })).toBeVisible();
  await page.getByRole("button", { name: "Restore tab" }).click();
  await expect(page.getByRole("textbox", { name: "Message Hermes about your tab" })).toBeVisible();
});


test("Prepare plan makes review discoverable when Hermes has not offered a plan", async ({ page }) => {
  const fixture = await tabsFixture(page, { offerPlan: false });
  await page.goto("/chat");
  await page.getByRole("button", { name: "Create a workspace tab" }).click();
  const input = page.getByRole("textbox", { name: "Message Hermes about your tab" });
  await input.fill("A reading desk."); await input.press("Enter");
  await expect(page.getByText("Should this be a personal reading list, or a shared one?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare plan", exact: true })).toHaveCount(0);
  await input.fill("Local only, with a table and notes."); await input.press("Enter");
  await page.getByRole("button", { name: "Prepare plan", exact: true }).click();
  await expect(page.getByRole("region", { name: "Plan to review" })).toBeVisible();
  expect(fixture.actions.map(item => item.action)).toEqual(["message", "message", "plan"]);
  await expect(page.getByRole("button", { name: "Build this preview" })).toBeVisible();
});
