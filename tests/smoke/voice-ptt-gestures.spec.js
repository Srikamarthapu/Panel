import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function setup(page, { deferred = false } = {}) {
  await mockWorkspace(page);
  const requests = { stt: 0, chat: 0 };
  await page.route("**/api/voice/stt", (route) => {
    requests.stt++;
    return route.fulfill({ json: { text: "Synthetic PTT test", confidence: 1 } });
  });
  await page.route("**/api/voice/chat", (route) => {
    if (route.request().method() === "POST") requests.chat++;
    return route.fulfill({ json: { response: "Synthetic response", autoSpeak: false } });
  });
  await page.addInitScript(({ deferred }) => {
    // A generated tone feeds a MediaStreamDestination only. No real input or
    // speaker is accessed; production AudioContext/MediaRecorder still run.
    const pending = [], streams = [];
    const fixture = { requests: 0, live: () => streams.filter((stream) => stream.getTracks().some((track) => track.readyState === "live")).length };
    const makeStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      oscillator.connect(destination); oscillator.start();
      void context.resume();
      streams.push(destination.stream);
      return destination.stream;
    };
    fixture.resolve = (index) => pending[index]?.(makeStream());
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: () => {
        fixture.requests++;
        return deferred ? new Promise((resolve) => pending.push(resolve)) : Promise.resolve(makeStream());
      },
    } });
    window.__pttFixture = fixture;
  }, { deferred });
  await page.goto("/");
  const dock = page.locator(".voiceDock"), hold = dock.locator(".voiceDock__hold");
  await expect(hold).toBeVisible();
  return { dock, hold, requests };
}

async function pointerDown(page, hold) {
  const rect = await hold.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
}

test("choosing a voice mode never opens the microphone", async ({ page }) => {
  const { dock, hold } = await setup(page);
  await expect(hold).toHaveText("Hold to talk");
  const modes = dock.getByRole("group", { name: "Voice mode" });
  await modes.getByRole("button", { name: "Hands-free", exact: true }).click();
  await expect(dock.getByRole("button", { name: "Start conversation", exact: true })).toBeVisible();
  await modes.getByRole("button", { name: "Push to talk", exact: true }).click();
  await expect(hold).toBeVisible();
  expect(await page.evaluate(() => window.__pttFixture.requests)).toBe(0);
});

test("pointer hold starts immediately and release sends one recorded utterance", async ({ page }) => {
  const { dock, hold, requests } = await setup(page);
  await pointerDown(page, hold);
  expect(await page.evaluate(() => window.__pttFixture.requests)).toBe(1);
  await expect(hold).toHaveAttribute("aria-pressed", "true");
  await expect(dock).toHaveAttribute("data-state", "capturing");
  // Hold a real recorder long enough to exceed the minimum utterance duration.
  await page.waitForTimeout(320);
  await page.mouse.up();
  await expect.poll(() => requests.stt).toBe(1);
  await expect.poll(() => requests.chat).toBe(1);
  await expect(dock).toHaveAttribute("data-state", "idle");
  await expect(hold).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__pttFixture.live())).toBe(0);
});

for (const key of ["Space", "Enter"]) {
  test(`${key} hold and release follows the same recording path`, async ({ page }) => {
    const { dock, hold, requests } = await setup(page);
    await hold.focus(); await page.keyboard.down(key);
    await expect(dock).toHaveAttribute("data-state", "capturing");
    await page.waitForTimeout(320);
    await page.keyboard.up(key);
    await expect.poll(() => requests.stt).toBe(1);
    await expect(dock).toHaveAttribute("data-state", "idle");
    expect(requests.chat).toBe(1);
  });
}

test("pointer cancellation and keyboard blur discard held audio", async ({ page }) => {
  const { dock, hold, requests } = await setup(page);
  await pointerDown(page, hold);
  await expect(dock).toHaveAttribute("data-state", "capturing");
  await hold.dispatchEvent("pointercancel", { pointerId: 1, button: 0, isPrimary: true });
  await page.mouse.up();
  await expect(dock).toHaveAttribute("data-state", "idle");
  await hold.focus(); await page.keyboard.down("Space");
  await expect(dock).toHaveAttribute("data-state", "capturing");
  await dock.getByRole("group", { name: "Voice mode" }).getByRole("button", { name: "Hands-free", exact: true }).focus();
  await page.keyboard.up("Space");
  await expect(dock).toHaveAttribute("data-state", "idle");
  expect(requests.stt).toBe(0); expect(requests.chat).toBe(0);
  expect(await page.evaluate(() => window.__pttFixture.live())).toBe(0);
});

test("releasing pending permission discards a late stream and permits a fresh hold", async ({ page }) => {
  const { dock, hold, requests } = await setup(page, { deferred: true });
  await pointerDown(page, hold);
  await expect(dock.locator(".voiceDock__caption--polite")).toHaveText("Waiting for microphone permission");
  await page.mouse.up();
  await expect(dock).toHaveAttribute("data-state", "idle");
  await pointerDown(page, hold);
  expect(await page.evaluate(() => window.__pttFixture.requests)).toBe(2);
  await page.evaluate(() => window.__pttFixture.resolve(0));
  await expect.poll(() => page.evaluate(() => window.__pttFixture.live())).toBe(0);
  await page.evaluate(() => window.__pttFixture.resolve(1));
  await expect(dock).toHaveAttribute("data-state", "capturing");
  await hold.dispatchEvent("pointercancel", { pointerId: 1, button: 0, isPrimary: true });
  await page.mouse.up();
  await expect(dock).toHaveAttribute("data-state", "idle");
  expect(requests.stt).toBe(0); expect(requests.chat).toBe(0);
});
