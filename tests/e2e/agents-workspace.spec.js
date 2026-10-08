import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

function agentCard(page, name) {
  return page.getByRole("article", { name, exact: true });
}

test("Agents page presents reported totals, honest unavailable metrics, and separate profile management", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockWorkspace(page, { agents: [
    {
      id: "atlas", name: "Atlas", color: "blue", soul: "# Atlas\n\nResearch claims from primary sources.", provider: "provider-a", model: "model-a", workingDirectory: "/QA/work/atlas",
      stats: {
        runs: { total: 4, completed: 3, failed: 1, cancelled: 0, interrupted: 0 },
        runtime: { totalMs: 125000, reportedRuns: 4, availability: "reported" },
        usage: { inputTokens: 8000, outputTokens: 4400, totalTokens: 12400, reportedRuns: 4, availability: "reported" },
        cost: { amount: 1.25, currency: "USD", reportedRuns: 4, availability: "reported" },
        lastRunAt: "2026-10-07T08:00:00.000Z",
      },
    },
    {
      id: "forge", name: "Forge", color: "peach", soul: "# Forge\n\nImplement focused, verified changes.", provider: "", model: "", workingDirectory: "/QA/work/forge",
      stats: {
        runs: { total: 1, completed: 1, failed: 0, cancelled: 0, interrupted: 0 },
        runtime: { totalMs: null, reportedRuns: 0, availability: "unavailable" },
        usage: { inputTokens: null, outputTokens: null, totalTokens: null, reportedRuns: 0, availability: "unavailable" },
        cost: { amount: null, currency: null, reportedRuns: 0, availability: "unavailable" },
        lastRunAt: "2026-10-07T07:00:00.000Z",
      },
    },
  ] });

  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const atlas = agentCard(page, "Atlas");
  const forge = agentCard(page, "Forge");
  await expect(atlas).toBeVisible();
  await expect(forge).toBeVisible();
  await expect(atlas.getByText("2m", { exact: true })).toBeVisible();
  await expect(atlas.getByText("12.4K", { exact: true })).toBeVisible();
  await expect(atlas.getByText("$1.25", { exact: true })).toBeVisible();
  await expect(forge.getByText("Not reported", { exact: true })).toHaveCount(3);
  await expect(atlas.getByText("may differ from your provider bill.", { exact: false })).toBeVisible();

  const nextAgentPoll = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes("/api/agents?archived=true"));
  await atlas.getByRole("button", { name: "Hide details for Atlas" }).click();
  await nextAgentPoll;
  await expect(atlas.getByRole("button", { name: "Show details for Atlas" })).toHaveAttribute("aria-expanded", "false");
  await expect(atlas.getByText("may differ from your provider bill.", { exact: false })).toBeHidden();
  await atlas.getByRole("button", { name: "Show details for Atlas" }).click();
  await expect(atlas.getByRole("button", { name: "Hide details for Atlas" })).toHaveAttribute("aria-expanded", "true");

  await forge.getByRole("button", { name: "Show details for Forge" }).click();
  await expect(forge.getByRole("button", { name: "Hide details for Forge" })).toHaveAttribute("aria-expanded", "true");
  await expect(forge.getByText("Workspace default", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open conversation", exact: true })).toHaveCount(2);

  const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: "test-results/agents-workspace-desktop.png", fullPage: true });

  await atlas.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(agentCard(page, "Atlas")).toHaveCount(0);
  await page.getByRole("button", { name: "Archived", exact: false }).click();
  await expect(agentCard(page, "Atlas")).toBeVisible();
  await expect(agentCard(page, "Atlas").getByRole("button", { name: "Restore agent", exact: true })).toBeVisible();
});

test("Agents page keeps a profile visible when its prior conversation is archived and starts a fresh one on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockWorkspace(page, {
    sessions: [
      { id: "qa-main", name: "Main conversation" },
      { id: "atlas-session", name: "Atlas conversation", agentId: "atlas", archivedAt: "2026-10-07T08:00:00.000Z" },
    ],
    agents: [{
      id: "atlas", sessionId: "atlas-session", name: "Atlas", color: "lilac", soul: "# Atlas\n\nKeep a concise evidence trail.",
      stats: {
        runs: { total: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 },
        runtime: { totalMs: null, reportedRuns: 0, availability: "unavailable" },
        usage: { inputTokens: null, outputTokens: null, totalTokens: null, reportedRuns: 0, availability: "unavailable" },
        cost: { amount: null, currency: null, reportedRuns: 0, availability: "unavailable" },
        lastRunAt: null,
      },
    }],
  });

  await page.goto("/agents");
  const atlas = agentCard(page, "Atlas");
  await expect(atlas).toBeVisible();
  const startConversation = atlas.getByRole("button", { name: "Start new conversation", exact: true });
  await expect(startConversation).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: "test-results/agents-workspace-mobile.png", fullPage: true });

  await startConversation.click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole("combobox", { name: "Switch session" })).not.toHaveValue("atlas-session");
});
