import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

const spec = {
  title: "Research desk",
  description: "Keep local research inputs together, then ask Hermes to review the exact values.",
  blocks: [
    { id: "warning", type: "text", title: "Untrusted text", text: '<img src=x onerror="window.__injected=true"> stays text' },
    { id: "topic", type: "field", title: "Research topic", label: "Topic", kind: "text" },
    { id: "mode", type: "field", title: "Review depth", label: "Mode", kind: "select", options: ["Quick", "Careful"] },
    { id: "notes", type: "notes", title: "Working notes", label: "Notes" },
    { id: "checks", type: "checklist", title: "Checks", items: ["Cite sources", "Flag uncertainty"] },
    { id: "facts", type: "table", title: "Source notes", columns: ["Source", "Finding"] },
    { id: "review", type: "action", title: "Hermes review", label: "Review research", prompt: "Investigate {{topic}} in {{mode}}. Notes: {{notes}}. Checklist: {{checks}}. Rows: {{facts}}." },
  ],
};

test("native custom tab persists the latest edit and keeps Hermes behind exact review", async ({ page }) => {
  await mockWorkspace(page);
  const actionRequests = [], putRequests = [], savedStates = [];
  let releaseFirstSave;
  const firstSaveGate = new Promise(resolve => { releaseFirstSave = resolve; });
  let currentRun = null, actionPolls = 0, stopCount = 0, stopFailed = false, failNextPoll = false, failSaves = false;

  await page.route("**/api/workspace-tabs/test-tab**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname.endsWith("/artifact")) return route.fulfill({ json: { spec, version: "11111111-1111-1111-1111-111111111111" } });
    if (url.pathname.endsWith("/state")) {
      if (method === "GET") return route.fulfill({ json: { value: { fields: {}, notes: { notes: "from disk" }, checklists: {}, tables: {} } } });
      const value = request.postDataJSON().value;
      putRequests.push(value);
      if (putRequests.length === 1) await firstSaveGate;
      if (failSaves) return route.fulfill({ status: 500, json: { error: "Temporary save failure" } });
      savedStates.push(value);
      return route.fulfill({ json: { saved: true } });
    }
    if (method === "POST") {
      const body = request.postDataJSON(); actionRequests.push(body); actionPolls = 0;
      currentRun = { id: body.requestId, sessionId: "tab-execution", state: "active", statusLabel: "Checking sources", response: "" };
      return route.fulfill({ status: 202, json: { run: currentRun } });
    }
    return route.fulfill({ json: { tab: { id: "test-tab", title: "Research desk", storagePath: "/QA/workspace-tabs/test-tab", executionSessionId: "tab-execution", publishedVersion: "11111111-1111-1111-1111-111111111111" }, messages: [], run: currentRun } });
  });

  await page.route("**/api/voice/runs**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "DELETE") {
      stopCount += 1; stopFailed = true;
      return route.fulfill({ status: 500, json: { error: "Stop transport unavailable" } });
    }
    if (!url.searchParams.get("actionId")) return route.fulfill({ json: { run: currentRun } });
    if (failNextPoll) { failNextPoll = false; return route.fulfill({ status: 503, json: { error: "Temporary run status failure" } }); }
    actionPolls += 1;
    const mayFinish = actionRequests.length === 1 ? actionPolls >= 2 : stopFailed && actionPolls >= 3;
    if (mayFinish) currentRun = { ...currentRun, state: "complete", statusLabel: "Complete", response: `Verified answer ${actionRequests.length}` };
    return route.fulfill({ json: { run: currentRun } });
  });

  await page.goto("/workspace/test-tab");
  await expect(page.getByRole("heading", { name: "Research desk", exact: true }).first()).toBeVisible();
  await expect(page.getByText("/QA/workspace-tabs/test-tab", { exact: true })).toBeVisible();
  await expect(page.getByText(spec.blocks[0].text, { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Research desk custom tab" }).locator("iframe, script, img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__injected)).toBeUndefined();

  const notes = page.getByRole("textbox", { name: "Notes" });
  await expect(notes).toHaveValue("from disk");
  await notes.fill("First draft");
  await expect.poll(() => putRequests.length).toBe(1);
  await notes.fill("Latest draft");
  await page.waitForTimeout(150);
  expect(putRequests).toHaveLength(1);
  releaseFirstSave();
  await expect.poll(() => putRequests.length).toBe(2);
  await expect.poll(() => savedStates.at(-1)?.notes?.notes).toBe("Latest draft");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "Topic" }).fill("coastal erosion");
  await page.getByRole("combobox", { name: "Mode" }).selectOption("Careful");
  await page.getByRole("checkbox", { name: "Cite sources" }).check();
  await page.getByRole("button", { name: "Add row" }).click();
  await page.getByRole("textbox", { name: "Source, row 1" }).fill("NOAA");
  await page.getByRole("textbox", { name: "Finding, row 1" }).fill("Rising seas");
  await expect.poll(() => savedStates.at(-1)?.tables?.facts?.[0]?.Finding).toBe("Rising seas");

  const expectedPrompt = 'Investigate coastal erosion in Careful. Notes: Latest draft. Checklist: Cite sources. Rows: [{"Source":"NOAA","Finding":"Rising seas"}].';
  await page.getByRole("button", { name: "Review research" }).click();
  const review = page.getByRole("dialog", { name: "Review before Hermes runs" });
  await expect(review).toBeVisible();
  await expect(review.getByText(expectedPrompt, { exact: true })).toBeVisible();
  expect(actionRequests).toEqual([]);
  await review.getByRole("button", { name: "Run with Hermes" }).evaluate(button => { button.click(); button.click(); });
  await page.getByText("Latest result", { exact: true }).click();
  await expect(page.getByText("Verified answer 1", { exact: true })).toBeVisible();
  expect(actionRequests).toHaveLength(1);
  expect(actionRequests[0]).toMatchObject({ action: "run", text: expectedPrompt });

  await page.getByRole("button", { name: "Review research" }).click();
  failNextPoll = true;
  await review.getByRole("button", { name: "Run with Hermes" }).click();
  await expect(review.getByText("Could not refresh this request: Temporary run status failure. Monitoring will retry.", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Open execution chat" })).toBeVisible();
  await expect(review.getByRole("button", { name: "Stop request" })).toBeVisible();
  await review.getByRole("button", { name: "Stop request" }).click();
  await expect(review.getByText("Could not stop this request: Stop transport unavailable", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Open execution chat" })).toBeVisible();
  await expect(review).toHaveCount(0);
  await page.getByText("Latest result", { exact: true }).click();
  await expect(page.getByText("Verified answer 2", { exact: true })).toBeVisible();
  expect(stopCount).toBe(1);

  await page.evaluate(() => { window.__editedWorkspaceTab = null; window.addEventListener("panel:edit-workspace-tab", event => { window.__editedWorkspaceTab = event.detail; }, { once: true }); });
  await page.getByRole("button", { name: "Edit tab" }).click();
  expect(await page.evaluate(() => window.__editedWorkspaceTab)).toEqual({ id: "test-tab" });
  await page.getByRole("button", { name: "Close tab planner" }).click();
  const audit = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations).toEqual([]);

  failSaves = true;
  await notes.fill("Retry this save");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  failSaves = false;
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect.poll(() => savedStates.at(-1)?.notes?.notes).toBe("Retry this save");

  failSaves = true;
  await notes.fill("Recovered after reload");
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  failSaves = false;
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Notes" })).toHaveValue("Recovered after reload");
  await expect.poll(() => savedStates.at(-1)?.notes?.notes).toBe("Recovered after reload");

  const restoredNotes = page.getByRole("textbox", { name: "Notes" });
  await restoredNotes.fill("Saved during navigation");
  await page.goto("/chat");
  await expect.poll(() => savedStates.at(-1)?.notes?.notes).toBe("Saved during navigation");
});
