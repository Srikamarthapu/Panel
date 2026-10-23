import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

test("discarding an old recorder cannot stop a fresh selected input acquired before old finalization", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const status = page.getByTestId("discarded-switch-status");
  await page.getByRole("button", { name: "Start discardable capture" }).click();
  await expect(status).toContainText("old-ready · capturing");
  await page.getByRole("button", { name: "Select built-in during capture" }).click();
  await expect(status).toContainText("fresh-acquired · starting");
  await expect(page.getByTestId("discarded-switch-stats")).toContainText("requests 2");
  await expect(page.getByTestId("discarded-switch-stats")).toContainText("old live; fresh live");
  await expect(page.getByTestId("discarded-switch-stats")).toContainText("selected mac-input");
  await page.getByRole("button", { name: "Finish discarded recorder" }).click();
  await expect(status).toContainText("passed · capturing");
  await expect(page.getByTestId("discarded-switch-stats")).toContainText("old stopped; fresh live");
  await expect(page.getByTestId("discarded-switch-stats")).toContainText("STT 0");
});

test("a committed PTT release survives a same-callback microphone change and later uses the selected input", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const status = page.getByTestId("recorder-switch-status");
  await page.getByRole("button", { name: "Start committed capture" }).click();
  await expect(status).toContainText("old-ready · capturing");
  await page.waitForTimeout(320);
  await page.getByRole("button", { name: "Release and select built-in microphone" }).click();
  await expect(status).toContainText("switching · transcribing");
  await expect(page.getByTestId("recorder-switch-stats")).toContainText("old live");
  await page.getByRole("button", { name: "Finish committed recorder" }).click();
  await expect(status).toContainText("passed · capturing");
  await expect(page.getByTestId("recorder-switch-stats")).toContainText("requests 2");
  await expect(page.getByTestId("recorder-switch-stats")).toContainText("selected mac-input");
  await expect(page.getByTestId("recorder-switch-stats")).toContainText("STT 1");
  await expect(page.getByTestId("recorder-switch-stats")).toContainText("old stopped; fresh live");
});

test("a continuous WAV committed before React state publication survives a microphone change", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const status = page.getByTestId("vad-switch-status");
  await page.getByRole("button", { name: "Start conversation capture" }).click();
  await expect(status).toContainText("listening · listening");
  await page.getByRole("button", { name: "Begin synthetic speech" }).click();
  await expect(status).toContainText("capturing · capturing");
  await page.getByRole("button", { name: "End speech and select built-in microphone" }).click();
  await expect(status).toContainText("passed · idle");
  await expect(page.getByTestId("vad-switch-stats")).toContainText("STT 1");
  await expect(page.getByTestId("vad-switch-stats")).not.toContainText("bytes 0");
});

test("microphone loss after committed PTT preserves recorder finalization and transcription", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const section = page.getByRole("heading", { name: "Committed PTT microphone loss" }).locator("..");
  const status = page.getByTestId("ptt-loss-status");
  await section.getByRole("button", { name: "Start loss-boundary PTT" }).click();
  await expect(status).toContainText("capturing · capturing");
  await page.waitForTimeout(320);
  await section.getByRole("button", { name: "Release as microphone disconnects" }).click();
  await expect(status).toContainText("submitted · transcribing");
  await expect(page.getByTestId("ptt-loss-stats")).toContainText("old stopped; pending yes");
  await section.getByRole("button", { name: "Finish loss-boundary recorder" }).click();
  await expect(status).toContainText("passed · idle");
  await expect(page.getByTestId("ptt-loss-stats")).toContainText("STT 1");
});

test("failed continuous mic recovery preserves the committed WAV and reply", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const section = page.getByRole("heading", { name: "Committed continuous microphone loss" }).locator("..");
  const status = page.getByTestId("vad-loss-status");
  await section.getByRole("button", { name: "Start continuous loss fixture" }).click();
  await expect(status).toContainText("listening · listening");
  await section.getByRole("button", { name: "Begin loss-boundary speech" }).click();
  await expect(status).toContainText("capturing · capturing");
  await section.getByRole("button", { name: "End speech as microphone disconnects" }).click();
  await expect(status).toContainText("passed · listening");
  await expect(page.getByTestId("vad-loss-stats")).toContainText("requests 2; STT 1");
  await expect(page.getByTestId("vad-loss-stats")).not.toContainText("bytes 0");
});

test("an ended continuous microphone is rebound before recovery reports success", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const section = page.getByRole("heading", { name: "Successful microphone loss recovery" }).locator("..");
  const status = page.getByTestId("mic-recovery-success-status");
  await section.getByRole("button", { name: "Start recovery fixture" }).click();
  await expect(status).toContainText("listening · listening");
  await section.getByRole("button", { name: "Disconnect synthetic microphone" }).click();
  await expect(status).toContainText("awaiting-success · starting");
  await expect(page.getByTestId("mic-recovery-success-stats")).toContainText("reconnected 0");
  await section.getByRole("button", { name: "Signal replacement detector ready" }).click();
  await expect(status).toContainText("passed · listening");
  await expect(page.getByTestId("mic-recovery-success-stats")).toContainText("streams stopped,live");
  await expect(page.getByTestId("mic-recovery-success-stats")).toContainText("detectors 0:destroyed,1:active");
  await expect(page.getByTestId("mic-recovery-success-stats")).toContainText("reconnected 1");
});

test("cancelling mic recovery stops its late stream without publishing success", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const section = page.getByRole("heading", { name: "Explicit recovery cancellation" }).locator("..");
  const status = page.getByTestId("mic-recovery-cancel-status");
  await section.getByRole("button", { name: "Start recovery fixture" }).click();
  await expect(status).toContainText("listening · listening");
  await section.getByRole("button", { name: "Disconnect synthetic microphone" }).click();
  await expect(status).toContainText("recovery-pending · starting");
  await section.getByRole("button", { name: "Cancel microphone recovery" }).click();
  await expect(status).toContainText("passed · idle");
  await expect(page.getByTestId("mic-recovery-cancel-stats")).toContainText("streams stopped,stopped");
  await expect(page.getByTestId("mic-recovery-cancel-stats")).toContainText("reconnected 0");
});

test("selecting a microphone cancels stale recovery and the next explicit session uses that input", async ({ page }) => {
  await mockWorkspace(page);
  await page.goto("/dev/voice-lifecycle");
  const section = page.getByRole("heading", { name: "Selected-input recovery cancellation" }).locator("..");
  const status = page.getByTestId("mic-recovery-select-status");
  await section.getByRole("button", { name: "Start recovery fixture" }).click();
  await expect(status).toContainText("listening · listening");
  await section.getByRole("button", { name: "Disconnect synthetic microphone" }).click();
  await expect(status).toContainText("recovery-pending · starting");
  await section.getByRole("button", { name: "Select built-in during recovery" }).click();
  await expect(status).toContainText("stale-stopped · idle");
  await expect(page.getByTestId("mic-recovery-select-stats")).toContainText("streams stopped,stopped");
  await expect(page.getByTestId("mic-recovery-select-stats")).toContainText("reconnected 0");
  await section.getByRole("button", { name: "Start selected microphone" }).click();
  await expect(status).toContainText("passed · listening");
  await expect(page.getByTestId("mic-recovery-select-stats")).toContainText("streams stopped,stopped,live");
  await expect(page.getByTestId("mic-recovery-select-stats")).toContainText("selected mac-input");
  await expect(page.getByTestId("mic-recovery-select-stats")).toContainText("detectors 0:destroyed,2:active");
});
