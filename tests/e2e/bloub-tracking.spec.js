import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

async function eyeCenter(page) {
  return page.locator(".bloubAvatar mask path[transform]").evaluateAll(eyes => {
    const centers = eyes.map(eye => {
      const values = eye.getAttribute("transform").match(/matrix\(([^)]+)\)/)?.[1].split(/[ ,]+/).map(Number);
      return values ? { x: values[4], y: values[5] } : null;
    }).filter(Boolean);
    return { x: centers.reduce((sum, eye) => sum + eye.x, 0) / centers.length, y: centers.reduce((sum, eye) => sum + eye.y, 0) / centers.length };
  });
}

async function openBloub(page) {
  await mockWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Bloub", exact: true }).click();
  const avatar = page.locator(".bloubAvatar");
  await expect(avatar).toBeVisible();
  return avatar.boundingBox();
}

test("idle Bloub eyes follow actual cursor movement down, up, right and left", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const bounds = await openBloub(page);
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(center.x, center.y + 160);
  await expect.poll(async () => (await eyeCenter(page)).y, { timeout: 1000 }).toBeGreaterThan(3);
  await page.mouse.move(center.x, center.y - 160);
  await expect.poll(async () => (await eyeCenter(page)).y, { timeout: 1000 }).toBeLessThan(-3);
  await page.mouse.move(center.x + 200, center.y);
  await expect.poll(async () => (await eyeCenter(page)).x, { timeout: 1000 }).toBeGreaterThan(3);
  await page.mouse.move(center.x - 200, center.y);
  await expect.poll(async () => (await eyeCenter(page)).x, { timeout: 1000 }).toBeLessThan(-3);
  expect(errors).toEqual([]);
});

test("reduced motion keeps Bloub's rendered eyes still when the cursor moves", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const bounds = await openBloub(page);
  const before = await eyeCenter(page);
  await page.mouse.move(bounds.x, bounds.y);
  await page.mouse.move(bounds.x + bounds.width, bounds.y + bounds.height);
  await expect.poll(() => eyeCenter(page)).toEqual(before);
});

test("visible Bloub updates gaze in place without measuring layout on every frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const bounds = await openBloub(page);
  const avatar = page.locator(".bloubAvatar");
  await avatar.evaluate(svg => {
    const audit = {
      body: svg.querySelector('[data-bloub-role="body"]'),
      eye: svg.querySelector('[data-bloub-role="mask-eye"]'),
      childListMutations: 0,
      bodyGeometryMutations: 0,
      layoutReads: 0,
      rafCount: 0,
    };
    audit.observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "childList") audit.childListMutations += 1;
        if (record.target === audit.body && record.attributeName === "d") audit.bodyGeometryMutations += 1;
      }
    });
    audit.observer.observe(svg, { subtree: true, childList: true, attributes: true, attributeFilter: ["d"] });
    window.__bloubRenderAudit = audit;
    const countRaf = () => {
      audit.rafCount += 1;
      audit.rafId = requestAnimationFrame(countRaf);
    };
    audit.rafId = requestAnimationFrame(countRaf);

    const original = SVGElement.prototype.getBoundingClientRect;
    SVGElement.prototype.getBoundingClientRect = function (...args) {
      if (this.classList?.contains("bloubAvatar")) audit.layoutReads += 1;
      return original.apply(this, args);
    };
  });

  await page.mouse.move(bounds.x + bounds.width / 2 + 180, bounds.y + bounds.height / 2);
  await expect.poll(async () => (await eyeCenter(page)).x, { timeout: 1000 }).toBeGreaterThan(3);
  await page.waitForTimeout(320);

  const audit = await avatar.evaluate(svg => {
    const state = window.__bloubRenderAudit;
    const sameBody = state.body === svg.querySelector('[data-bloub-role="body"]');
    const sameEye = state.eye === svg.querySelector('[data-bloub-role="mask-eye"]');
    state.observer.disconnect();
    cancelAnimationFrame(state.rafId);
    return {
      sameBody,
      sameEye,
      childListMutations: state.childListMutations,
      bodyGeometryMutations: state.bodyGeometryMutations,
      layoutReads: state.layoutReads,
      rafCount: state.rafCount,
    };
  });

  expect(audit.sameBody).toBe(true);
  expect(audit.sameEye).toBe(true);
  expect(audit.childListMutations).toBe(0);
  expect(audit.bodyGeometryMutations).toBeGreaterThan(0);
  expect(audit.bodyGeometryMutations).toBeGreaterThanOrEqual(Math.floor(audit.rafCount * 0.55));
  expect(audit.layoutReads).toBeLessThanOrEqual(1);
  console.info(`Bloub renderer: ${audit.bodyGeometryMutations}/${audit.rafCount} body updates per rAF sample, ${audit.childListMutations} child-list changes, ${audit.layoutReads} layout reads`);
});
