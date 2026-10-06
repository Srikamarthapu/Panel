import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function status(page) {
  await mockWorkspace(page);
  await page.route("**/api/control-center", route => route.fulfill({ json: { gateway: { online: true, state: "running" }, activity: [{ title: "Unrelated background job", updatedAt: new Date().toISOString() }] } }));
  await page.route("**/api/voice/status", route => route.fulfill({ json: { status: "running", config: { enabled: true, autoSpeak: false } } }));
  await page.route("**/api/voice/activity**", route => route.fulfill({ json: { events: [] } }));
}

test("idle voice controls explain the gesture without unrelated activity", async ({ page }) => {
  await status(page);
  await page.goto("/");
  const dock = page.locator(".voiceDock");
  await expect(dock.getByText("Hold the button, Space, or Enter. Release to send.")).toBeVisible();
  await expect(dock.getByText("Unrelated background job")).toHaveCount(0);
});

test("a pending microphone request immediately shows connecting feedback", async ({ page }) => {
  await status(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise(() => {}) } });
  });
  await page.goto("/");
  await page.getByRole("group", { name: "Voice mode" }).getByRole("button", { name: "Hands-free", exact: true }).click();
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  await expect(page.getByRole("button", { name: "End conversation", exact: true })).toBeVisible();
  await expect(page.locator(".voiceDock__caption--polite")).toHaveText("Waiting for microphone permission");
});

test("denied microphone permission offers a retry and a readable error", async ({ page }) => {
  await status(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException("Denied for this test", "NotAllowedError")) } });
  });
  await page.goto("/");
  await page.getByRole("group", { name: "Voice mode" }).getByRole("button", { name: "Hands-free", exact: true }).click();
  await page.getByRole("button", { name: "Start conversation", exact: true }).click();
  await expect(page.getByRole("button", { name: /Retry microphone/ })).toBeVisible();
  await expect(page.locator(".voiceDock")).toHaveAttribute("data-state", "error");
});
