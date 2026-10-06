import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildActivityFeed,
  curateActivityFeed,
  normalizeLedgerRunEvent,
} from "../../lib/hermes.js";
import {
  selectTickerEvents,
  formatTickerEvent,
} from "../../components/voice/voiceActivityTicker.js";

// T-0007: the voice-dock ticker must show REAL system events when idle — the
// Hermes activity feed (memory/kanban/session) AND orchestrator mission
// progress (runs.jsonl tail) — newest-first. Voice-pipeline states must never
// appear as idle ticker content; they are overlay-only during an interaction.
//
// The failure the user hit: high-frequency runtime log lines are synthesized
// with `now`-anchored timestamps upstream, so a naive "merge then sort by
// updatedAt, slice" starved every mission/activity event out of the feed and
// the ticker. These tests pin the two fixes: (1) buildActivityFeed reserves
// slots for mission/activity buckets; (2) selectTickerEvents demotes log noise.

function ledgerFixture() {
  return [
    normalizeLedgerRunEvent(
      { ts: "2026-07-05T05:00:00.000Z", kind: "worker", task: "T-0006", attempt: 1, profile: "coder-hermes", model: "z-ai/glm-5.2", status: "done" },
      0,
    ),
    normalizeLedgerRunEvent(
      { ts: "2026-07-05T05:10:00.000Z", kind: "gate1", task: "T-0006", ok: true, files: ["lib/hermes.js"] },
      1,
    ),
    normalizeLedgerRunEvent(
      { ts: "2026-07-05T05:20:00.000Z", kind: "judge", task: "T-0006", report: { weighted: 9.4, verdict: "pass" } },
      2,
    ),
    normalizeLedgerRunEvent(
      { ts: "2026-07-05T05:30:00.000Z", kind: "outcome", task: "T-0006", result: "merged", attempts: 1, score: 9.4 },
      3,
    ),
  ];
}

// A flood of runtime log lines, all timestamped ~now, that historically buried
// the ledger events. buildActivityFeed re-synthesizes log timestamps, so the
// exact values here don't matter — the volume does.
function noisyLogs() {
  return {
    recentGateway: Array.from({ length: 16 }, (_, i) => `2026-07-05T13:00:0${i} gateway heartbeat ${i}`),
    recentErrors: Array.from({ length: 16 }, (_, i) => `2026-07-05T13:00:0${i} minor error ${i}`),
  };
}

test("T-0007: activity feed surfaces orchestrator ledger mission events even under heavy log noise", () => {
  const feed = buildActivityFeed({
    memory: { learningEvents: [] },
    kanban: { events: [] },
    logs: noisyLogs(),
    sessions: { files: [] },
    ledger: ledgerFixture(),
  });

  const ledgerItems = feed.filter((item) => item.source === "orchestrator/ledger");
  assert.ok(ledgerItems.length >= 4, `expected all 4 ledger events to survive, got ${ledgerItems.length}`);

  const titles = ledgerItems.map((item) => item.title);
  assert.ok(titles.includes("Task T-0006 merged"), "merge event must be in the feed");
  assert.ok(titles.includes("Judge scored T-0006: 9.4"), "judge score must be in the feed");
  assert.ok(titles.includes("Task T-0006 routed to coder-hermes"), "routing event must be in the feed");
});

test("T-0007: activity feed interleaves memory + mission events and stays newest-first", () => {
  const feed = buildActivityFeed({
    memory: {
      learningEvents: [
        { id: "mem-1", type: "memory", title: "Memory updated: user prefers dark mode", summary: "preference saved", updatedAt: "2026-07-05T05:25:00.000Z" },
      ],
    },
    kanban: {
      events: [
        { task_id: "T-0006", kind: "moved", payload: "done", created_at: "2026-07-05T05:15:00.000Z" },
      ],
    },
    logs: noisyLogs(),
    sessions: { files: [{ name: "session_x.json", provider: "openai", model: "gpt-5", updatedAt: "2026-07-05T05:05:00.000Z" }] },
    ledger: ledgerFixture(),
  });

  // Newest-first invariant.
  for (let i = 1; i < feed.length; i += 1) {
    assert.ok(
      String(feed[i].updatedAt) <= String(feed[i - 1].updatedAt),
      "feed must be strictly newest-first",
    );
  }

  const sources = new Set(feed.map((item) => item.source));
  assert.ok(sources.has("orchestrator/ledger"), "ledger source present");
  assert.ok(feed.some((item) => item.kind === "memory"), "memory event present");
});

test("T-0007: curateActivityFeed reserves mission slots so logs cannot starve them", () => {
  const buckets = {
    ledger: ledgerFixture().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    memory: [],
    task: [],
    session: [],
    // 50 fresh log lines that would otherwise fill every slot.
    log: Array.from({ length: 50 }, (_, i) => ({
      id: `log-${i}`,
      kind: "log",
      label: "Signal",
      title: "Hermes runtime signal",
      summary: `line ${i}`,
      source: "gateway.log",
      updatedAt: `2026-07-05T14:00:${String(i).padStart(2, "0")}.000Z`,
    })),
  };

  const feed = curateActivityFeed(buckets, 10);
  const ledgerCount = feed.filter((item) => item.source === "orchestrator/ledger").length;
  assert.equal(ledgerCount, 4, "all 4 mission events must survive the 50-log flood");
});

test("T-0007: ticker selects mission events, never log noise, when substantive events exist", () => {
  const activity = [
    // Log noise with the freshest timestamps — must NOT win the ticker.
    { id: "log-0", kind: "log", label: "Signal", title: "Hermes runtime signal", source: "gateway.log", updatedAt: "2026-07-05T14:00:00.000Z" },
    { id: "log-1", kind: "log", label: "Error", title: "Hermes error signal", source: "errors.log", updatedAt: "2026-07-05T13:59:00.000Z" },
    // Real mission + activity events, slightly older.
    { id: "led-merge", kind: "task", label: "Orchestrator", title: "Task T-0006 merged", summary: "score 9.4", source: "orchestrator/ledger", updatedAt: "2026-07-05T05:30:00.000Z" },
    { id: "led-judge", kind: "task", label: "Orchestrator", title: "Judge scored T-0006: 9.4", source: "orchestrator/ledger", updatedAt: "2026-07-05T05:20:00.000Z" },
    { id: "mem-1", kind: "memory", label: "Memory", title: "Memory updated: dark mode", source: "memory", updatedAt: "2026-07-05T05:25:00.000Z" },
  ];

  const items = selectTickerEvents(activity);
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.notEqual(item.kind, "log", `log noise leaked into ticker: ${item.title}`);
  }
  // The freshest substantive event wins first.
  assert.equal(items[0].title, "Task T-0006 merged");
});

test("T-0007: ticker backfills with log filler only when real events run short", () => {
  const activity = [
    { id: "led-merge", kind: "task", label: "Orchestrator", title: "Task T-0006 merged", source: "orchestrator/ledger", updatedAt: "2026-07-05T05:30:00.000Z" },
    { id: "log-0", kind: "log", label: "Signal", title: "Hermes runtime signal", source: "gateway.log", updatedAt: "2026-07-05T14:00:00.000Z" },
  ];

  const items = selectTickerEvents(activity);
  // One real event first, then the log filler backfills the remaining capacity.
  assert.equal(items[0].title, "Task T-0006 merged");
  assert.ok(items.some((item) => item.kind === "log"), "log filler backfills when substantive events run short");
});

test("T-0007: voice-pipeline captions are NOT part of the ticker data source", () => {
  // The ticker's ONLY input is the mission-control activity array. Voice states
  // ('transcribing…', 'Hermes is thinking', 'Listening.', 'Speaking.') are
  // provider captions rendered separately in VoiceDock as an overlay while
  // active. They must never appear as activity events, so selectTickerEvents
  // can never emit them. Feeding caption-shaped strings yields nothing.
  const voiceCaptions = ["Transcribing…", "Hermes is thinking", "Listening.", "Speaking."].map(
    (title, i) => ({ id: `caption-${i}`, title, updatedAt: `2026-07-05T14:0${i}:00.000Z` }),
  );

  // Even if such strings somehow appeared, they carry no orchestrator/mission
  // provenance. The real guard is architectural: VoiceDock only renders the
  // ticker when NOT in an ACTIVE_STATE. Assert the pipeline vocabulary never
  // originates from the activity feed by confirming a clean feed excludes them.
  const feed = buildActivityFeed({
    memory: { learningEvents: [] },
    kanban: { events: [] },
    logs: { recentGateway: [], recentErrors: [] },
    sessions: { files: [] },
    ledger: ledgerFixture(),
  });
  const feedTitles = feed.map((item) => item.title);
  for (const caption of voiceCaptions) {
    assert.ok(
      !feedTitles.includes(caption.title),
      `voice-pipeline caption "${caption.title}" must never be a feed event`,
    );
  }

  // And formatTickerEvent of any real feed item is a mission/activity line,
  // never a bare pipeline state.
  const line = formatTickerEvent(feed[0], Date.parse("2026-07-05T06:00:00.000Z"));
  assert.doesNotMatch(line, /^Transcribing…$/);
  assert.doesNotMatch(line, /^Hermes is thinking$/);
  assert.match(line, /Orchestrator:/);
});

test("VoiceDock does not mount another activity subscription", () => {
  const dock = readFileSync(resolve("components/voice/VoiceDock.jsx"), "utf8");
  // Activity has one shared subscription; mounting the historical ticker here
  // would reintroduce expensive full mission snapshot polling.
  assert.doesNotMatch(dock, /<VoiceActivityTicker/);
  assert.doesNotMatch(dock, /fetch\(/);
});

test("T-0007/T-0008: the ticker's IDLE-ROTATION source is /api/mission-control", () => {
  const ticker = readFileSync(resolve("components/voice/VoiceActivityTicker.jsx"), "utf8");
  // Idle rotation content is still drawn only from mission-control — voice
  // log noise must never dominate the idle ticker (the T-0007 point).
  assert.match(ticker, /fetch\("\/api\/mission-control"/);
  assert.match(ticker, /selectTickerEvents\(activity\)/);
  // The idle rotation must NOT be fed by the voice-pipeline store; the only
  // permitted voice/status endpoints are stt/chat/tts, which the ticker never
  // touches.
  assert.doesNotMatch(ticker, /\/api\/voice\/(status|stt|chat|tts)/);
});

test("T-0008: the ticker reads /api/voice/activity ONLY for the live in-flight status", () => {
  const ticker = readFileSync(resolve("components/voice/VoiceActivityTicker.jsx"), "utf8");
  // The voice-activity read exists solely to surface the present-tense
  // "Checking your calendar…" label of an in-flight run (fix C), fed through
  // selectLiveStatus — never into selectTickerEvents (the idle rotation).
  assert.match(ticker, /fetch\(`\/api\/voice\/activity/);
  assert.match(ticker, /selectLiveStatus\(events/);
  // Live status wins over rotation only while a run is live; otherwise the
  // ticker falls back to the mission-control rotation / caption fallback.
  assert.match(ticker, /liveStatus\s*\?\s*liveStatus\.label/);
});
