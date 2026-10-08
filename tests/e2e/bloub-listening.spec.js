import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function installSilentMicrophone(page) {
  await page.addInitScript(() => {
    localStorage.setItem("hermes.talk.avatar", "bloub");
    const contexts = [];
    const streams = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const context = new AudioContext();
          const destination = context.createMediaStreamDestination();
          contexts.push(context);
          streams.push(destination.stream);
          return destination.stream;
        },
      },
    });
    window.__bloubVoiceFixture = { contexts, streams };
  });
}

async function prepareTalk(page) {
  await installSilentMicrophone(page);
  await mockWorkspace(page);
  await page.route("**/api/voice/status**", route => route.fulfill({ json: {
    status: "running",
    config: { autoSpeak: false, enabled: true, muteOutput: false },
  } }));
  await page.goto("/");
  await expect(page.locator('.talkWorkspace__orb .mcOrb--bloub[data-state="idle"]')).toBeVisible();
}

async function screenGeometry(avatar) {
  return avatar.evaluate(svg => {
    const bounds = node => {
      const box = node.getBBox();
      const matrix = node.getScreenCTM();
      const points = [
        new DOMPoint(box.x, box.y),
        new DOMPoint(box.x + box.width, box.y),
        new DOMPoint(box.x, box.y + box.height),
        new DOMPoint(box.x + box.width, box.y + box.height),
      ].map(point => point.matrixTransform(matrix));
      const xs = points.map(point => point.x);
      const ys = points.map(point => point.y);
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    };
    const body = bounds(svg.querySelector('[data-bloub-role="body"]'));
    const eyes = [...svg.querySelectorAll('[data-bloub-role="mask-eye"]')]
      .filter(node => node.getAttribute("display") !== "none" && Number(node.getAttribute("opacity") || 1) > 0.01)
      .map(bounds);
    const eyeUnion = {
      left: Math.min(...eyes.map(eye => eye.left)),
      right: Math.max(...eyes.map(eye => eye.right)),
      top: Math.min(...eyes.map(eye => eye.top)),
      bottom: Math.max(...eyes.map(eye => eye.bottom)),
    };
    const bodyWidth = body.right - body.left;
    const bodyHeight = body.bottom - body.top;
    const eyeWidth = eyeUnion.right - eyeUnion.left;
    const eyeHeight = eyeUnion.bottom - eyeUnion.top;
    return {
      eyes: eyes.length,
      bodyWidth,
      bodyHeight,
      eyeWidthRatio: eyeWidth / bodyWidth,
      eyeHeightRatio: eyeHeight / bodyHeight,
      eyeCenterX: ((eyeUnion.left + eyeUnion.right) / 2 - (body.left + body.right) / 2) / bodyWidth,
      eyeCenterY: ((eyeUnion.top + eyeUnion.bottom) / 2 - (body.top + body.bottom) / 2) / bodyHeight,
    };
  });
}

function expectFriendlyAttention(geometry) {
  expect(geometry.eyes).toBe(2);
  expect(geometry.bodyWidth).toBeGreaterThan(100);
  expect(geometry.bodyHeight).toBeGreaterThan(100);
  expect(Math.abs(geometry.eyeCenterX)).toBeLessThan(0.16);
  expect(Math.abs(geometry.eyeCenterY)).toBeLessThan(0.16);
  expect(geometry.eyeWidthRatio).toBeGreaterThan(0.18);
  expect(geometry.eyeWidthRatio).toBeLessThan(0.7);
  expect(geometry.eyeHeightRatio).toBeGreaterThan(0.08);
  expect(geometry.eyeHeightRatio).toBeLessThan(0.46);
}

for (const motion of ["reduce", "no-preference"]) test(`Bloub keeps friendly centered eyes while listening and capturing (${motion})`, async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: motion });
  await prepareTalk(page);
  const dock = page.locator(".voiceDock");
  const modes = dock.getByRole("group", { name: "Voice mode" });

  await modes.getByRole("button", { name: "Hands-free", exact: true }).click();
  await dock.getByRole("button", { name: "Start conversation", exact: true }).click();
  await expect(dock).toHaveAttribute("data-state", "listening", { timeout: 15000 });
  const listeningAvatar = page.locator('.talkWorkspace__orb .mcOrb--bloub[data-state="listening"] .bloubAvatar');
  await expect(listeningAvatar).toBeVisible();
  await expect.poll(async () => {
    try { expectFriendlyAttention(await screenGeometry(listeningAvatar)); return true; } catch { return false; }
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("friendly-listening.png") });

  await dock.getByRole("button", { name: "End conversation", exact: true }).click();
  await expect(dock).toHaveAttribute("data-state", "idle");
  await modes.getByRole("button", { name: "Push to talk", exact: true }).click();
  const hold = dock.locator(".voiceDock__hold");
  const box = await hold.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(dock).toHaveAttribute("data-state", "capturing", { timeout: 10000 });
  const capturingAvatar = page.locator('.talkWorkspace__orb .mcOrb--bloub[data-state="capturing"] .bloubAvatar');
  await expect(capturingAvatar).toBeVisible();
  await expect.poll(async () => {
    try { expectFriendlyAttention(await screenGeometry(capturingAvatar)); return true; } catch { return false; }
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("friendly-capturing.png") });
  await hold.dispatchEvent("pointercancel", { pointerId: 1, button: 0, isPrimary: true });
  await page.mouse.up();
  await expect(dock).toHaveAttribute("data-state", "idle");
});
