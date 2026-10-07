import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function installVoiceFixtures(page, { deferredPermission = false } = {}) {
  await page.addInitScript(({ deferredPermission }) => {
    const pending = [];
    const streams = [];
    const audioFixture = { instances: [], plays: 0, pauses: 0 };
    class FixtureAudio extends EventTarget {
      constructor(src = "") {
        super();
        this.src = src;
        this.currentTime = 0;
        this.muted = false;
        this.paused = true;
        audioFixture.instances.push(this);
      }
      play() {
        audioFixture.plays += 1;
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        audioFixture.pauses += 1;
        this.paused = true;
      }
    }
    const makeStream = () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      oscillator.connect(destination);
      oscillator.start();
      const stream = destination.stream;
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        Object.defineProperty(track, "stop", {
          configurable: true,
          value() {
            voiceFixture.stoppedTracks += 1;
            stop();
          },
        });
      }
      streams.push(stream);
      return stream;
    };
    const voiceFixture = {
      permissionRequests: 0,
      stoppedTracks: 0,
      liveTracks: () => streams.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === "live").length,
      resolvePermission: (index = 0) => pending[index]?.(makeStream()),
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia() {
          voiceFixture.permissionRequests += 1;
          return deferredPermission
            ? new Promise((resolve) => pending.push(resolve))
            : Promise.resolve(makeStream());
        },
      },
    });
    window.__voiceModeFixture = voiceFixture;
    window.__voiceAudioFixture = audioFixture;
    window.Audio = FixtureAudio;
  }, { deferredPermission });
}

async function preparePage(page, options) {
  const fixture = await mockWorkspace(page, options);
  await page.route("**/api/voice/status**", (route) => route.fulfill({ json: {
    status: "running",
    config: { autoSpeak: true, enabled: true, muteOutput: false },
  } }));
  await installVoiceFixtures(page, { deferredPermission: options?.deferredPermission });
  return fixture;
}

async function pointerDown(page, button) {
  const rect = await button.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
}

test("Chat entry stops a pending permission request and returning to Talk stays idle", async ({ page }) => {
  await preparePage(page, { deferredPermission: true });
  await page.goto("/");

  const dock = page.locator(".voiceDock");
  await dock.getByRole("group", { name: "Voice mode" }).getByRole("button", { name: "Hands-free", exact: true }).click();
  await dock.getByRole("button", { name: "Start conversation", exact: true }).click();
  await expect(dock.locator(".voiceDock__caption--polite")).toHaveText("Waiting for microphone permission");
  expect(await page.evaluate(() => window.__voiceModeFixture.permissionRequests)).toBe(1);

  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await page.evaluate(() => window.__voiceModeFixture.resolvePermission());
  await expect.poll(() => page.evaluate(() => window.__voiceModeFixture.stoppedTracks)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceModeFixture.liveTracks())).toBe(0);

  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Talk", exact: true }).click();
  await expect(page.locator(".voiceDock")).toHaveAttribute("data-state", "idle");
  expect(await page.evaluate(() => window.__voiceModeFixture.permissionRequests)).toBe(1);
});

test("an accepted spoken run survives Talk-to-Chat, then each surface selects its response mode", async ({ page }) => {
  const fixture = await preparePage(page);
  const chatRequests = [];
  let run = null;
  let completeRun = false;
  let streamedRunId = null;
  let speechRequests = 0;

  await page.route("**/api/voice/stt", (route) => route.fulfill({ json: { text: "Check the project notes", confidence: 1 } }));
  await page.route("**/api/voice/tts", async (route) => {
    speechRequests += 1;
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.alloc(512) });
  });
  await page.route("**/api/voice/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    chatRequests.push(body);
    const record = fixture.records.get(body.sessionId);
    record.messages.push({ id: `${body.actionId}:user`, role: "user", text: body.text });

    const spokenRequestCount = chatRequests.filter((request) => request.audio).length;
    if (body.audio && spokenRequestCount === 1) {
      run = { id: body.actionId, sessionId: body.sessionId, state: "active", textOnly: false, statusLabel: "Working" };
      streamedRunId = run.id;
      record.activeRun = run;
      record.lastRun = run;
      return route.fulfill({ json: { pending: true, mode: "action", actionId: run.id, statusLabel: run.statusLabel } });
    }

    const response = body.audio
      ? "The follow-up Talk voice response."
      : body.text.includes("after returning") ? "The next Chat response." : "The typed Chat response.";
    record.messages.push({ id: `${body.actionId}:answer`, role: "hermes", text: response });
    return route.fulfill({ json: { response, sessionId: body.sessionId } });
  });
  await page.route("**/api/voice/runs**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "DELETE") {
      fixture.requests.stoppedRuns.push(request.postDataJSON());
      return route.fulfill({ json: { run: { ...run, state: "cancelled" } } });
    }
    if (url.pathname.endsWith("/events")) {
      const body = url.searchParams.get("after") === "0" && run
        ? `event: text\ndata: ${JSON.stringify({ runId: streamedRunId, seq: 1, messageId: "answer", text: "This is a sentence spoken while the run is active." })}\n\n`
        : "";
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
    }
    if (request.method() === "GET" && run) {
      if (completeRun) {
        const record = fixture.records.get(run.sessionId);
        run = { ...run, state: "complete", response: "The accepted run finished as text in Chat.", updatedAt: new Date().toISOString() };
        record.activeRun = null;
        record.lastRun = run;
        if (!record.messages.some((message) => message.id === `${run.id}:answer`)) {
          record.messages.push({ id: `${run.id}:answer`, role: "hermes", text: run.response });
        }
      }
      return route.fulfill({ json: { run } });
    }
    return route.continue();
  });

  await page.goto("/");
  const dock = page.locator(".voiceDock");
  const hold = dock.locator(".voiceDock__hold");
  await pointerDown(page, hold);
  await expect(dock).toHaveAttribute("data-state", "capturing");
  await page.waitForTimeout(320);
  await page.mouse.up();
  await expect.poll(() => chatRequests.length).toBe(1);
  expect(chatRequests[0].audio).toBe(true);

  await expect.poll(() => page.evaluate(() => window.__voiceAudioFixture.instances.some((audio) => !audio.paused && audio.src.startsWith("blob:")))).toBe(true);
  const pausesBeforeNavigation = await page.evaluate(() => window.__voiceAudioFixture.pauses);
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__voiceAudioFixture.instances.every((audio) => audio.paused))).toBe(true);
  expect(await page.evaluate(() => window.__voiceAudioFixture.pauses)).toBeGreaterThan(pausesBeforeNavigation);
  expect(fixture.requests.stoppedRuns).toEqual([]);

  const speechRequestsAfterNavigation = speechRequests;
  completeRun = true;
  const acceptedAnswer = "The accepted run finished as text in Chat.";
  await expect(page.getByText(acceptedAnswer, { exact: true })).toBeVisible({ timeout: 20000 });
  expect(fixture.requests.stoppedRuns).toEqual([]);
  expect(speechRequests).toBe(speechRequestsAfterNavigation);

  await page.getByRole("textbox", { name: "Message Hermes" }).fill("A typed follow-up from Chat");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("The typed Chat response.", { exact: true })).toBeVisible();
  expect(chatRequests.at(-1).audio).toBe(false);
  expect(speechRequests).toBe(speechRequestsAfterNavigation);

  const permissionRequestsBeforeReturn = await page.evaluate(() => window.__voiceModeFixture.permissionRequests);
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Talk", exact: true }).click();
  await expect(page.locator(".voiceDock")).toHaveAttribute("data-state", "idle");
  expect(await page.evaluate(() => window.__voiceModeFixture.permissionRequests)).toBe(permissionRequestsBeforeReturn);

  const nextHold = page.locator(".voiceDock .voiceDock__hold");
  await pointerDown(page, nextHold);
  await expect(page.locator(".voiceDock")).toHaveAttribute("data-state", "capturing");
  await page.waitForTimeout(320);
  await page.mouse.up();
  await expect.poll(() => chatRequests.length).toBe(3);
  expect(chatRequests.at(-1).audio).toBe(true);

  await expect.poll(() => speechRequests).toBeGreaterThan(speechRequestsAfterNavigation);
  await expect.poll(() => page.evaluate(() => window.__voiceAudioFixture.instances.some((audio) => !audio.paused && audio.src.startsWith("blob:")))).toBe(true);
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Hermes" })).toBeVisible();
  await expect(page.getByText("The follow-up Talk voice response.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__voiceAudioFixture.instances.every((audio) => audio.paused))).toBe(true);

  await page.getByRole("textbox", { name: "Message Hermes" }).fill("A new text turn after returning to Chat");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("The next Chat response.", { exact: true })).toBeVisible();
  expect(chatRequests).toHaveLength(4);
  expect(chatRequests.at(-1).audio).toBe(false);
});
