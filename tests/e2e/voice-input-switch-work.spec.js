import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function pointerDown(page, locator) {
  const rect = await locator.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
}

async function verifyInputSwitchPreservesWork(page, { deferStt }) {
  const fixture = await mockWorkspace(page);
  const saved = [];
  const chatRequests = [];
  let run = null;
  let completeRun = false;
  let speechRequests = 0;
  let sttStarted = false;
  let releaseStt;

  await page.route("**/api/voice/status**", route => route.fulfill({ json: {
    status: "running",
    config: { enabled: true, autoSpeak: true, muteOutput: false, micDeviceId: "", speakerDeviceId: "" },
  } }));
  await page.route("**/api/voice/stt", async route => {
    sttStarted = true;
    if (deferStt) await new Promise(resolve => { releaseStt = resolve; });
    return route.fulfill({ json: { text: "Finish the accepted task", confidence: 1 } });
  });
  await page.route("**/api/voice/tts", route => {
    speechRequests += 1;
    return route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.alloc(512) });
  });
  await page.route("**/api/voice/chat", route => {
    const request = route.request();
    if (request.method() === "PUT") {
      saved.push(request.postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() !== "POST") return route.continue();
    const body = request.postDataJSON();
    chatRequests.push(body);
    const record = fixture.records.get(body.sessionId);
    run = {
      id: body.actionId,
      sessionId: body.sessionId,
      state: "active",
      statusLabel: "Working",
      textOnly: false,
      createdAt: new Date().toISOString(),
    };
    record.activeRun = run;
    record.lastRun = run;
    return route.fulfill({ status: 202, json: { pending: true, mode: "action", actionId: run.id, statusLabel: run.statusLabel } });
  });
  await page.route("**/api/voice/runs**", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "DELETE") {
      fixture.requests.stoppedRuns.push(request.postDataJSON());
      return route.fulfill({ json: { run: { ...run, state: "cancelled" } } });
    }
    if (url.pathname.endsWith("/events")) {
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" });
    }
    if (request.method() === "GET" && run) {
      if (completeRun && run.state !== "complete") {
        const record = fixture.records.get(run.sessionId);
        run = { ...run, state: "complete", response: "The accepted task is complete.", updatedAt: new Date().toISOString() };
        record.activeRun = null;
        record.lastRun = run;
        record.messages.push({ id: `${run.id}:result`, runId: run.id, role: "hermes", text: run.response });
      }
      return route.fulfill({ json: { run } });
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    const streams = [];
    const audio = { plays: 0, replyPlays: 0, instances: [] };
    class FixtureAudio extends EventTarget {
      constructor(src = "") {
        super();
        this.src = src;
        this.currentTime = 0;
        this.muted = false;
        this.paused = true;
        audio.instances.push(this);
      }
      play() {
        audio.plays += 1;
        if (String(this.src).startsWith("blob:")) audio.replyPlays += 1;
        this.paused = false;
        return Promise.resolve();
      }
      pause() { this.paused = true; }
    }
    const makeStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.connect(destination);
      oscillator.start();
      streams.push(destination.stream);
      return destination.stream;
    };
    const device = { requests: 0, constraints: [] };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "bluetooth-input", label: "Bluetooth headset microphone" },
        { kind: "audioinput", deviceId: "mac-input", label: "MacBook Pro Microphone" },
        { kind: "audiooutput", deviceId: "bluetooth-output", label: "Bluetooth headphones" },
      ],
      addEventListener() {},
      removeEventListener() {},
      getUserMedia(constraints) {
        device.requests += 1;
        device.constraints.push(constraints);
        return Promise.resolve(makeStream());
      },
    } });
    Object.defineProperty(window, "MediaSource", { configurable: true, value: undefined });
    window.Audio = FixtureAudio;
    window.__voiceInputWorkFixture = { audio, device };
  });

  await page.goto("/");
  const dock = page.locator(".voiceDock");
  const hold = page.locator('[data-talk-voice-control="primary"]');
  await pointerDown(page, hold);
  await expect(dock).toHaveAttribute("data-state", "capturing");
  await page.waitForTimeout(320);
  await page.mouse.up();

  if (deferStt) {
    await expect.poll(() => sttStarted).toBe(true);
    expect(chatRequests).toHaveLength(0);
  } else {
    await expect.poll(() => chatRequests.length).toBe(1);
    expect(chatRequests[0].audio).toBe(true);
  }
  const requestsBeforeSelection = await page.evaluate(() => window.__voiceInputWorkFixture.device.requests);

  await page.getByRole("link", { name: "Customize" }).click();
  await page.locator('a[href="/voice"]').first().click();
  await page.getByRole("combobox", { name: "Microphone", exact: true }).selectOption("mac-input");
  await expect.poll(() => saved.at(-1)).toEqual({ micDeviceId: "mac-input" });
  expect(await page.evaluate(() => window.__voiceInputWorkFixture.device.requests)).toBe(requestsBeforeSelection);
  expect(fixture.requests.stoppedRuns).toEqual([]);

  if (deferStt) {
    releaseStt();
    await expect.poll(() => chatRequests.length).toBe(1);
    expect(chatRequests[0].audio).toBe(true);
  }
  completeRun = true;
  await expect.poll(() => speechRequests, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__voiceInputWorkFixture.audio.replyPlays), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceInputWorkFixture.audio.instances.some((item) => String(item.src).startsWith("blob:") && !item.paused))).toBe(true);
  expect(fixture.requests.stoppedRuns).toEqual([]);
  expect(await page.evaluate(() => window.__voiceInputWorkFixture.device.requests)).toBe(requestsBeforeSelection);
}

test("changing input preserves an accepted voice task and its spoken reply", async ({ page }) => {
  await verifyInputSwitchPreservesWork(page, { deferStt: false });
});

test("changing input preserves transcription before the task is accepted", async ({ page }) => {
  await verifyInputSwitchPreservesWork(page, { deferStt: true });
});
