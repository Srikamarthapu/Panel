import { test, expect } from "playwright/test";
import { mockWorkspace } from "../helpers/workspace.js";

const richAnswer = [
  "## Migration notes",
  "",
  "Use the migration needle after checking the [very-long-documentation-address-that-must-wrap-cleanly](https://example.com/documentation/projects/panel/migrations/a-very-long-reference-that-must-not-widen-the-conversation).",
  "",
  "```js",
  "const deliberatelyLongIdentifier = 'this line stays intact and scrolls inside the code block instead of widening the page';",
  "console.log(deliberatelyLongIdentifier);",
  "```",
  "",
  "| Check | Evidence with a deliberately long value |",
  "| --- | --- |",
  "| Storage | session-scoped-draft-value-that-stays-readable-on-a-narrow-screen |",
].join("\n");

function historyFixture() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "hermes" : "user",
    text: index === 1 ? richAnswer : index === 6 ? "Please compare the second migration needle before release." : `Conversation checkpoint ${index + 1}.`,
  }));
}

test("Chat rich answers stay usable on narrow screens and code can be copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockWorkspace(page, { sessions: [{ id: "qa-rich-chat", name: "Rich answer review", messages: historyFixture() }] });
  await page.goto("/chat");

  const code = page.locator(".messageCode");
  await expect(code.getByText("JavaScript", { exact: true })).toBeVisible();
  await code.getByRole("button", { name: "Copy JavaScript code" }).click();
  await expect(code.getByRole("button", { name: "Copy JavaScript code" })).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("deliberatelyLongIdentifier");

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => {
    const pre = document.querySelector(".messageCode pre");
    const table = document.querySelector(".messageTable");
    const link = document.querySelector('.messageContent a[href^="https://example.com"]');
    const body = link.closest(".conversationMessage__body");
    return {
      page: document.documentElement.scrollWidth - innerWidth,
      code: pre.scrollWidth - pre.clientWidth,
      table: table.scrollWidth - table.clientWidth,
      linkRight: link.getBoundingClientRect().right,
      bodyRight: body.getBoundingClientRect().right,
      linkWrap: getComputedStyle(link).overflowWrap,
      scripts: document.querySelectorAll(".messageContent script").length,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.code).toBeGreaterThan(0);
  expect(overflow.table).toBeGreaterThanOrEqual(0);
  expect(overflow.linkRight).toBeLessThanOrEqual(overflow.bodyRight + 1);
  expect(overflow.linkWrap).toBe("anywhere");
  expect(overflow.scripts).toBe(0);
});

test("conversation search counts matches, moves between turns, and keeps history reading position", async ({ page }) => {
  const fixture = await mockWorkspace(page, { sessions: [{ id: "qa-search-chat", name: "Search review", messages: historyFixture() }] });
  await page.goto("/chat");

  await page.getByRole("button", { name: "Search conversation" }).click();
  const search = page.getByRole("search");
  await search.getByRole("searchbox", { name: "Search this conversation" }).fill("migration needle");
  await expect(search.getByRole("status")).toHaveText("1 of 2");
  await expect(page.locator(".conversationMessage[data-search-match]")).toContainText("Migration notes");

  await search.getByRole("button", { name: "Next match" }).click();
  await expect(search.getByRole("status")).toHaveText("2 of 2");
  await expect(page.locator(".conversationMessage[data-search-match]")).toContainText("second migration needle");
  await search.getByRole("button", { name: "Previous match" }).click();
  await expect(search.getByRole("status")).toHaveText("1 of 2");

  const record = fixture.records.get("qa-search-chat");
  record.messages.push({ id: "message-9", role: "hermes", text: "A new reply arrived without the search phrase." });
  record.session.updatedAt = new Date(Date.now() + 2000).toISOString();
  await expect(page.locator(".conversationMessage")).toHaveCount(9, { timeout: 7000 });
  await expect(page.locator(".conversationMessage[data-search-match]")).toContainText("Migration notes");
  expect(await page.locator(".conversationHistory").evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);

  await search.getByRole("button", { name: "Close conversation search" }).click();
  await expect(page.getByRole("button", { name: "Search conversation" })).toBeFocused();
});

test("Chat and Talk rails become a reachable horizontal row after desktop-to-mobile resize", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkspace(page);
  for (const route of ["/chat", "/"]) {
    await page.goto(route);
    await page.setViewportSize({ width: 390, height: 844 });
    const layout = await page.locator(".controlNav").evaluate(nav => {
      const primary = nav.querySelector(".controlNav__primary");
      const links = [...primary.querySelectorAll(":scope > .controlNav__link")].slice(0, 6).map(link => {
        const rect = link.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const brand = nav.querySelector(".controlNav__brand > a").getBoundingClientRect();
      const search = nav.querySelector(".controlSearch").getBoundingClientRect();
      return { direction: getComputedStyle(primary).flexDirection, navHeight: nav.getBoundingClientRect().height, brandWidth: brand.width, searchWidth: search.width, links };
    });
    expect(layout.direction).toBe("row");
    expect(layout.navHeight).toBeLessThanOrEqual(51);
    expect(layout.brandWidth).toBeGreaterThanOrEqual(28);
    expect(layout.searchWidth).toBeGreaterThanOrEqual(34);
    expect(new Set(layout.links.map(link => Math.round(link.y))).size).toBe(1);
    expect(layout.links.every(link => link.width === 36 && link.height === 36)).toBe(true);
    await expect(page.getByRole("link", { name: route === "/chat" ? "Chat" : "Talk", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Search destinations" })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
  }
});

test("four Talk companions stay compact so the primary voice controls remain in the mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, { agents: Array.from({ length: 4 }, (_, index) => ({ id: `mobile-agent-${index}`, name: `Agent ${index + 1}`, soul: `Handles focused task ${index + 1}.` })) });
  await page.goto("/");
  await expect(page.locator(".talkWorkspace__presence figure")).toHaveCount(4);
  const layout = await page.locator(".talkWorkspace__presence").evaluate(presence => {
    const cardElements = [...presence.querySelectorAll("figure")];
    const scrollerElement = cardElements[0].parentElement;
    const cards = cardElements.map(card => card.getBoundingClientRect());
    const scroller = scrollerElement.getBoundingClientRect();
    const ready = presence.querySelector(".talkWorkspace__caption").getBoundingClientRect();
    const voice = document.querySelector(".voiceDock").getBoundingClientRect();
    return {
      cardHeights: cards.map(card => card.height),
      sameRow: new Set(cards.map(card => Math.round(card.y))).size === 1,
      scrollWidth: scrollerElement.scrollWidth,
      clientWidth: scrollerElement.clientWidth,
      scrollerHeight: scroller.height,
      readyTop: ready.top,
      voiceBottom: voice.bottom,
    };
  });
  expect(layout.cardHeights.every(height => height <= 60)).toBe(true);
  expect(layout.sameRow).toBe(true);
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
  expect(layout.scrollerHeight).toBeLessThanOrEqual(68);
  expect(layout.readyTop).toBeLessThan(700);
  expect(layout.voiceBottom).toBeLessThanOrEqual(844);
});

test("desktop Talk companions keep readable names beside the enlarged avatars", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkspace(page, { agents: ["Builder", "Designer", "Researcher", "Editor"].map((name, index) => ({ id: `desktop-agent-${index}`, name, soul: `Synthetic ${name.toLowerCase()} task.` })) });
  await page.goto("/");
  const cards = page.locator(".talkWorkspace__presence figure");
  await expect(cards).toHaveCount(4);
  const geometry = await cards.evaluateAll(elements => elements.map(card => {
    const caption = card.querySelector("figcaption");
    const name = caption.querySelector("strong");
    const status = caption.querySelector("span");
    const lineCount = element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    };
    return { captionWidth: caption.getBoundingClientRect().width, nameLines: lineCount(name), statusLines: lineCount(status) };
  }));
  expect(geometry.every(card => card.captionWidth >= 90)).toBe(true);
  expect(geometry.every(card => card.nameLines === 1)).toBe(true);
  expect(geometry.every(card => card.statusLines <= 2)).toBe(true);
});
