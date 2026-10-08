import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

const names = ["Builder", "Designer", "Researcher", "Reviewer", "Planner", "Writer", "Analyst", "Editor", "Tester", "Architect"];

async function checkComposition(page, count) {
  const presence = page.locator(".talkWorkspace__presence");
  await expect(presence.locator("figure")).toHaveCount(count);
  await expect(presence.locator("figure [data-bloub-role='body']")).toHaveCount(count);
  const geometry = await presence.evaluate(root => {
    const box = element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const figures = [...root.querySelectorAll("figure")];
    return {
      main: box(root.querySelector(".talkWorkspace__orb [data-bloub-role='body']")),
      bodies: figures.map(node => box(node.querySelector("[data-bloub-role='body']"))),
      bubbles: figures.map(node => box(node.querySelector("figcaption"))),
      bubbleContent: figures.map(node => box(node.querySelector("figcaption span"))),
      caption: box(root.querySelector(".talkWorkspace__caption")),
      nestedScrollers: [root, ...root.querySelectorAll("*")].filter(node => {
        const css = getComputedStyle(node);
        return (/auto|scroll/.test(css.overflowX) && node.scrollWidth > node.clientWidth + 1)
          || (/auto|scroll/.test(css.overflowY) && node.scrollHeight > node.clientHeight + 1);
      }).map(node => node.className?.baseVal || node.className),
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const overlaps = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
  expect(geometry.nestedScrollers).toEqual([]);
  expect(geometry.overflow).toBe(false);
  for (const [index, body] of geometry.bodies.entries()) {
    expect(body.width).toBeGreaterThanOrEqual(45);
    expect(body.width / geometry.main.width).toBeGreaterThanOrEqual(.30);
    expect(body.left).toBeGreaterThanOrEqual(0);
    expect(body.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(overlaps(body, geometry.main)).toBe(false);
    expect(geometry.caption.top).toBeGreaterThanOrEqual(body.bottom);
    expect(geometry.caption.top).toBeGreaterThanOrEqual(geometry.bubbles[index].bottom);
    for (let other = index + 1; other < geometry.bodies.length; other++) {
      expect(overlaps(body, geometry.bodies[other])).toBe(false);
      expect(overlaps(geometry.bubbles[index], geometry.bubbles[other])).toBe(false);
    }
    for (const bubble of geometry.bubbles) expect(overlaps(body, bubble)).toBe(false);
  }
  for (const bubble of geometry.bubbles) {
    expect(bubble.left).toBeGreaterThanOrEqual(0);
    expect(bubble.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(overlaps(bubble, geometry.main)).toBe(false);
  }
  if (geometry.viewport <= 480) {
    for (const bubble of geometry.bubbleContent) expect(bubble.width).toBeGreaterThanOrEqual(100);
  }
}

for (const count of [0, 2, 6, 10]) {
  test(`${count} companions remain readable without nested scrolling at desktop and narrow widths`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const agents = names.slice(0, count).map((name, index) => ({
      id: `teammate-${index}`, name, color: ["blue", "peach", "lilac", "sage"][index % 4],
      ...(index % 2 === 0 ? { activeRun: { id: `run-${index}`, state: "active", statusLabel: "Reviewing the implementation and checking results" } } : {}),
    }));
    await mockWorkspace(page, { agents });
    await page.addInitScript(ids => {
      localStorage.setItem("panel.selectedAgents.v1", JSON.stringify(ids));
      localStorage.setItem("hermes.talk.avatar", "bloub");
    }, agents.map(agent => agent.id));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Talk", exact: true })).toBeVisible();
    const toggle = page.getByRole("button", { name: "Agents", exact: true });
    if (await toggle.getAttribute("aria-expanded") === "true") await page.getByRole("button", { name: "Close agents" }).click();
    await checkComposition(page, count);
    if (count === 6) await page.screenshot({ path: testInfo.outputPath("companions-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 1101, height: 780 });
    await toggle.click();
    await checkComposition(page, count);
    await page.getByRole("button", { name: "Close agents" }).click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await checkComposition(page, count);
    }
    if (count === 6) await page.screenshot({ path: testInfo.outputPath("companions-mobile.png"), fullPage: true });
    expect(errors).toEqual([]);
  });
}
