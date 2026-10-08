import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

async function freshProfile(page) {
  await mockWorkspace(page);
  let decision = null;
  await page.route("**/api/onboarding", route => {
    if (route.request().method() === "POST") decision = { version: 1, outcome: route.request().postDataJSON().outcome, updatedAt: new Date().toISOString() };
    return route.fulfill({ json: { decision, needsOnboarding: !decision, existingEvidence: [], hermes: { installed: true, configured: true }, storage: { panelData: "/QA/panel-data", hermesHome: "/QA/hermes-home" } } });
  });
  return () => decision;
}
test("fresh setup is optional, remembers skipping, and can be reopened from Settings", async ({ page }) => {
  const decision = await freshProfile(page);
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "Your agent, ready when you are." })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Skip setup", exact: true }).click();
  expect(decision()?.outcome).toBe("skipped");
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip setup" })).toHaveCount(0);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Replay setup guide", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A quick tour of your workspace." })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Replay setup guide", exact: true })).toBeFocused();
});

test("first-run guide shows real check failures and local paths and can finish without voice", async ({ page }) => {
  await freshProfile(page);
  await page.route("**/api/models/catalog**", route => route.fulfill({ status: 503, json: { error: "Provider catalog is temporarily unavailable." } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Provider catalog is temporarily unavailable.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Voice needs more local setup", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("/QA/panel-data", { exact: true })).toBeVisible();
  await expect(page.getByText("/QA/hermes-home", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Talk", exact: true })).toBeVisible();
});
