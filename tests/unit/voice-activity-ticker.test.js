import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  formatTickerEvent,
  relativeTickerTime,
  selectTickerEvents,
  truncateTickerText,
} from "../../components/voice/voiceActivityTicker.js";

test("voice activity ticker selects the three newest real events", () => {
  const events = [
    { id: "old", title: "older", updatedAt: "2026-07-03T10:00:00.000Z" },
    { id: "new-a", title: "new a", updatedAt: "2026-07-03T10:03:00.000Z" },
    { id: "missing-title", summary: "ignored", updatedAt: "2026-07-03T10:04:00.000Z" },
    { id: "new-c", title: "new c", updatedAt: "2026-07-03T10:02:00.000Z" },
    { id: "new-b", title: "new b", updatedAt: "2026-07-03T10:03:00.000Z" },
  ];

  assert.deepEqual(
    selectTickerEvents(events).map((item) => item.id),
    ["new-b", "new-a", "new-c"],
  );
});

test("voice activity ticker formats an event without falling back to idle copy", () => {
  const now = new Date("2026-07-03T10:05:00.000Z").getTime();
  const text = formatTickerEvent(
    {
      id: "ledger",
      label: "Orchestrator",
      title: "Task T-0003 merged",
      summary: "score 9",
      source: "orchestrator/ledger",
      updatedAt: "2026-07-03T10:04:00.000Z",
    },
    now,
  );

  assert.match(text, /^Orchestrator: Task T-0003 merged/);
  assert.match(text, /score 9/);
  assert.match(text, /1m ago/);
  assert.doesNotMatch(text, /Idle\. Press to start\./);
});

test("voice activity ticker text stays compact", () => {
  const input = "a".repeat(100);
  const out = truncateTickerText(input, 16);
  assert.equal(out.length, 16);
  assert.ok(out.endsWith("…"));
});

test("voice activity ticker relative time handles fresh events", () => {
  const now = new Date("2026-07-03T10:05:00.000Z").getTime();
  assert.equal(relativeTickerTime("2026-07-03T10:04:58.000Z", now), "just now");
  assert.equal(relativeTickerTime("2026-07-03T09:05:00.000Z", now), "1h ago");
});

test("voice activity ticker has a single-line overflow guard to prevent strip layout shift", () => {
  const component = readFileSync(
    resolve("components/voice/VoiceActivityTicker.jsx"),
    "utf8",
  );

  assert.match(component, /whiteSpace:\s*"nowrap"/);
  assert.match(component, /overflow:\s*"hidden"/);
  assert.match(component, /textOverflow:\s*"ellipsis"/);
});

test("voice activity ticker preserves long real event text for visual ellipsis", () => {
  const longTitle = "Task T-0003 routed through a very long worker profile name with many extra words";
  const text = formatTickerEvent(
    {
      id: "long",
      label: "Orchestrator",
      title: longTitle,
      summary: "A long but real summary from the orchestrator ledger.",
      source: "orchestrator/ledger/runs.jsonl",
      updatedAt: "2026-07-03T10:04:58.000Z",
    },
    new Date("2026-07-03T10:05:00.000Z").getTime(),
  );

  assert.match(text, new RegExp(longTitle));
});
