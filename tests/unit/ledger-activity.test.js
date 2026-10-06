import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeLedgerRunEvent } from "../../lib/hermes.js";

test("ledger worker entries surface task routing", () => {
  const event = normalizeLedgerRunEvent({
    ts: "2026-07-03T10:00:00.000Z",
    kind: "worker",
    task: "T-0003",
    attempt: 1,
    profile: "coder",
    model: "openai/gpt-5",
    status: "done",
  });

  assert.equal(event.kind, "task");
  assert.equal(event.label, "Orchestrator");
  assert.equal(event.title, "Task T-0003 routed to coder");
  assert.match(event.summary, /attempt 1/);
  assert.match(event.summary, /openai\/gpt-5/);
});

test("ledger gate entries distinguish pass and block", () => {
  const passed = normalizeLedgerRunEvent({
    ts: "2026-07-03T10:01:00.000Z",
    kind: "gate1",
    task: "T-0003",
    ok: true,
    files: ["components/voice/VoiceDock.jsx"],
  });
  const blocked = normalizeLedgerRunEvent({
    ts: "2026-07-03T10:02:00.000Z",
    kind: "gate1",
    task: "T-0004",
    ok: false,
    failures: ["package.json not allowed"],
  });

  assert.equal(passed.title, "Gate passed for T-0003");
  assert.equal(blocked.title, "Gate blocked T-0004");
  assert.match(blocked.summary, /1 failure/);
});

test("ledger judge and outcome entries surface score and merge", () => {
  const judged = normalizeLedgerRunEvent({
    ts: "2026-07-03T10:03:00.000Z",
    kind: "judge",
    task: "T-0003",
    report: { weighted: 9.2, verdict: "pass" },
  });
  const merged = normalizeLedgerRunEvent({
    ts: "2026-07-03T10:04:00.000Z",
    kind: "outcome",
    task: "T-0003",
    result: "merged",
    attempts: 1,
    score: 9.2,
  });

  assert.equal(judged.title, "Judge scored T-0003: 9.2");
  assert.match(judged.summary, /verdict pass/);
  assert.equal(merged.title, "Task T-0003 merged");
  assert.match(merged.summary, /score 9.2/);
});
