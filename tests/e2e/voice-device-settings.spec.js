import { test, expect } from "playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockWorkspace } from "../helpers/workspace.js";

test("voice device settings save an explicit input and clean up the finite meter", async ({ page }) => {
  await mockWorkspace(page);
  const saved = [];
  await page.route("**/api/voice/status**", route => route.fulfill({ json: {
    status: "running",
    config: { enabled: true, autoSpeak: false, micDeviceId: "", speakerDeviceId: "" },
  } }));
  await page.route("**/api/voice/chat", route => {
    if (route.request().method() === "PUT") {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 503, json: { error: "No model request expected" } });
  });
  await page.addInitScript(() => {
    const fixture = { lastConstraints: null, stoppedTracks: 0 };
    const makeStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        Object.defineProperty(track, "stop", { configurable: true, value() { fixture.stoppedTracks += 1; stop(); } });
      }
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "mac-input", label: "MacBook Pro Microphone" },
        { kind: "audiooutput", deviceId: "bluetooth-output", label: "Bluetooth headphones" },
      ],
      addEventListener() {},
      removeEventListener() {},
      async getUserMedia(constraints) {
        fixture.lastConstraints = constraints;
        return makeStream();
      },
    } });
    window.__voiceDeviceFixture = fixture;
  });

  await page.goto("/voice");
  const microphone = page.getByRole("combobox", { name: "Microphone", exact: true });
  await expect(microphone).toContainText("MacBook Pro Microphone");
  await expect(page.getByText(/For clearer Bluetooth headphone audio/)).toBeVisible();

  await microphone.selectOption("mac-input");
  await expect.poll(() => saved.at(-1)).toEqual({ micDeviceId: "mac-input" });
  await page.getByRole("button", { name: "Test microphone" }).click();
  await expect(page.getByRole("img", { name: "Microphone input level" })).toBeVisible();
  expect(await page.evaluate(() => window.__voiceDeviceFixture.lastConstraints)).toEqual({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: "mac-input" },
    },
  });

  await microphone.selectOption("");
  await expect.poll(() => page.evaluate(() => window.__voiceDeviceFixture.stoppedTracks)).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Test microphone" })).toHaveAttribute("aria-pressed", "false");

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("microphone test timeout releases a permission stream that resolves late", async ({ page }) => {
  await mockWorkspace(page);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 15_000 ? 500 : delay, ...args);
    const pending = [];
    const fixture = { requests: 0, stoppedTracks: 0 };
    const makeStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        Object.defineProperty(track, "stop", { configurable: true, value() { fixture.stoppedTracks += 1; stop(); } });
      }
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mac-input", label: "MacBook Pro Microphone" }],
      addEventListener() {},
      removeEventListener() {},
      getUserMedia: () => {
        fixture.requests += 1;
        return new Promise(resolve => pending.push(resolve));
      },
    } });
    fixture.resolvePermissions = () => {
      for (const resolve of pending.splice(0)) resolve(makeStream());
    };
    window.__voiceDeviceFixture = fixture;
  });

  await page.goto("/voice");
  const testButton = page.getByRole("button", { name: "Test microphone" });
  await testButton.click();
  await expect.poll(() => page.evaluate(() => window.__voiceDeviceFixture.requests)).toBeGreaterThan(0);
  await expect(testButton).toHaveAttribute("aria-pressed", "false");
  const requestCount = await page.evaluate(() => window.__voiceDeviceFixture.requests);
  await page.evaluate(() => window.__voiceDeviceFixture.resolvePermissions());
  await expect.poll(() => page.evaluate(() => window.__voiceDeviceFixture.stoppedTracks)).toBe(requestCount);
  await expect(page.getByRole("img", { name: "Microphone input level" })).toHaveCount(0);
});

test("changing the saved microphone detaches a pending input and the next hold uses the selected device", async ({ page }) => {
  await mockWorkspace(page);
  const saved = [];
  await page.route("**/api/voice/status**", route => route.fulfill({ json: {
    status: "running",
    config: { enabled: true, autoSpeak: false, micDeviceId: "", speakerDeviceId: "" },
  } }));
  await page.route("**/api/voice/chat", route => {
    if (route.request().method() === "PUT") {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 503, json: { error: "No model request expected" } });
  });
  await page.addInitScript(() => {
    const pending = [];
    const fixture = { constraints: [], requests: 0, stopped: [0, 0] };
    const makeStream = requestIndex => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        Object.defineProperty(track, "stop", { configurable: true, value() {
          fixture.stopped[requestIndex] = (fixture.stopped[requestIndex] || 0) + 1;
          stop();
        } });
      }
      return destination.stream;
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "bluetooth-input", label: "Bluetooth headset microphone" },
        { kind: "audioinput", deviceId: "mac-input", label: "MacBook Pro Microphone" },
        { kind: "audiooutput", deviceId: "bluetooth-output", label: "Bluetooth headphones" },
      ],
      addEventListener() {},
      removeEventListener() {},
      getUserMedia(constraints) {
        const requestIndex = fixture.requests++;
        fixture.constraints.push(constraints);
        if (requestIndex === 0) return new Promise(resolve => pending.push(() => resolve(makeStream(requestIndex))));
        return Promise.resolve(makeStream(requestIndex));
      },
    } });
    fixture.resolveOldPermission = () => pending.splice(0).forEach(resolve => resolve());
    window.__voiceDeviceFixture = fixture;
  });

  await page.goto("/");
  const dock = page.locator(".voiceDock");
  await page.locator(".talkWorkspace__mode").click();
  await dock.getByRole("button", { name: /Start conversation with/ }).click();
  await expect.poll(() => page.evaluate(() => window.__voiceDeviceFixture.requests)).toBe(1);

  await page.getByRole("link", { name: "Customize" }).click();
  await page.locator('a[href="/voice"]').first().click();
  const microphone = page.getByRole("combobox", { name: "Microphone", exact: true });
  await microphone.selectOption("mac-input");
  await expect.poll(() => saved.at(-1)).toEqual({ micDeviceId: "mac-input" });
  expect(await page.evaluate(() => window.__voiceDeviceFixture.requests)).toBe(1);

  await page.getByRole("link", { name: /Back to workspace/ }).click();
  const hold = page.locator('[data-talk-voice-control="primary"]');
  const rect = await hold.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.__voiceDeviceFixture.requests)).toBe(2);
  await expect(dock).toHaveAttribute("data-state", "capturing");
  expect(await page.evaluate(() => window.__voiceDeviceFixture.constraints[1])).toEqual({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      deviceId: { exact: "mac-input" },
    },
  });

  await page.evaluate(() => window.__voiceDeviceFixture.resolveOldPermission());
  await expect.poll(() => page.evaluate(() => window.__voiceDeviceFixture.stopped[0])).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceDeviceFixture.stopped[1])).toBe(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
});
