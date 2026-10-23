import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

test("Memory distinguishes shared Hermes memory from each assistant's role, history, and live task", async ({ page }) => {
  const generatedAt = "2026-10-15T18:00:00.000Z";
  const fixture = await mockWorkspace(page, {
    sessions: [
      { id: "qa-main", name: "Main conversation", messages: [{ id: "main-user", role: "user", text: "Remember the release preference." }] },
      { id: "atlas-session", name: "Atlas conversation", agentId: "atlas", messages: [{ id: "atlas-answer", role: "hermes", text: "I checked the release evidence." }], activeRun: { id: "atlas-run", state: "active", statusLabel: "Checking evidence", taskLabel: "Review the release checklist", updatedAt: generatedAt } },
    ],
    agents: [{
      id: "atlas", sessionId: "atlas-session", name: "Atlas", soul: "# Atlas\n\nReview release evidence and cite what was verified.",
      capabilityPolicy: { version: 1, tools: { mode: "allow", ids: ["read_file"] }, skills: { mode: "allow", ids: [] } },
    }],
    memory: {
      scope: { title: "One shared Hermes memory", description: "Long-term memory belongs to the Hermes installation. Saved teammates do not own separate memory databases.", source: "/QA/hermes/memories" },
      sharedMemory: {
        user: `Prefers verified releases. ${"Evidence before claims. ".repeat(55)}`,
        memory: "Release checks are shared by Hermes-mode conversations.",
        files: [{ name: "MEMORY.md", path: "/QA/hermes/memories/MEMORY.md", words: 120, updatedAt: generatedAt }],
        learningEvents: [],
      },
      people: [
        { id: "main", kind: "main", name: "Main assistant", role: "Your primary Hermes assistant for Talk and Chat.", activity: null, conversations: [{ id: "qa-main", name: "Main conversation", updatedAt: generatedAt, archivedAt: null, messages: [{ id: "main-user", role: "user", text: "Remember the release preference.", createdAt: generatedAt }] }], storage: { role: "Core instructions; no teammate SOUL.md.", conversations: "Main Panel history.", memory: "Shared Hermes memory." }, capabilitySummary: "Workspace capabilities" },
        { id: "atlas", kind: "saved", name: "Atlas", role: "# Atlas\n\nReview release evidence and cite what was verified.", activity: null, conversations: [{ id: "atlas-session", name: "Atlas conversation", updatedAt: generatedAt, archivedAt: null, messages: [{ id: "atlas-answer", role: "assistant", text: "I checked the release evidence.", createdAt: generatedAt }] }], storage: { role: "Saved in Atlas SOUL.md; not a memory database.", conversations: "History associated with Atlas.", memory: "Shared Hermes memory." }, capabilitySummary: "1 tools · 0 skills" },
      ],
      generatedAt,
    },
  });

  await page.goto("/memory");
  await expect(page.getByRole("button", { name: /Main assistant/ })).toBeVisible();
  await page.getByRole("button", { name: /Atlas/ }).click();
  await expect(page.getByRole("heading", { name: "Atlas", exact: true })).toBeVisible();
  await expect(page.getByText("Working now", { exact: true })).toBeVisible();
  await expect(page.getByText("Review the release checklist", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved in Atlas SOUL.md; not a memory database.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "One shared Hermes memory", exact: true })).toHaveCount(1);
  await expect(page.getByText("Saved teammates do not own separate memory databases.", { exact: false })).toBeVisible();
  await expect(page.getByText("I checked the release evidence.", { exact: true })).toBeHidden();
  await page.getByText("Atlas conversation", { exact: true }).click();
  await expect(page.getByText("I checked the release evidence.", { exact: true })).toBeVisible();
  await expect(page.getByText("Show full content", { exact: true })).toBeVisible();

  const atlasButton = page.getByRole("button", { name: /Atlas/ });
  await expect(atlasButton).toContainText("Checking evidence");
  const atlasRecord = fixture.records.get("atlas-session");
  atlasRecord.activeRun = null;
  atlasRecord.lastRun = { ...atlasRecord.lastRun, state: "complete", statusLabel: "Complete" };
  await expect(atlasButton).toContainText("1 tools · 0 skills", { timeout: 10000 });

  const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: /Main assistant/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Atlas/ })).toBeVisible();
});
