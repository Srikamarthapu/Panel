import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// T-0010 Law 8 ("complete thoughts"): a completed data/action run's summary IS
// the spoken answer. The store must keep it long enough to speak in full — the
// old 240-char cap amputated replies mid-sentence ("And C…"). Noise events keep
// the tight 240 cap so the store/ticker stay small and readable.

function makeLongSentence(chars) {
  // A realistic answer: many short clauses so we can prove the WHOLE thing
  // survives, well past 240 chars.
  let out = "";
  let i = 0;
  while (out.length < chars) {
    out += `Item number ${i} is on your list. `;
    i += 1;
  }
  return out.slice(0, chars);
}

async function withStore(fn) {
  const originalCwd = process.cwd();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "voice-completion-cap-"));
  try {
    process.chdir(tmp);
    const mod = await import(`../../lib/voiceActivity.js?cap=${Date.now()}`);
    await fn(mod);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("typed completion persists silent delivery without the old 8000-character truncation", async () => {
  await withStore(({ addVoiceActivity, getVoiceActivity }) => {
    const answer = "Detailed response\n\n" + "x".repeat(9000);
    addVoiceActivity({
      id: "typed:complete", sessionId: "text-session", kind: "tool",
      state: "complete", source: "voice/action", summary: answer, textOnly: true,
    });
    const [stored] = getVoiceActivity({ sessionId: "text-session" });
    assert.equal(stored.textOnly, true);
    assert.equal(stored.summary, answer);
    assert.ok(stored.summary.startsWith("Detailed response\n\n"));
  });
});

test("Law 8: a voice/data completion summary is stored WELL beyond 240 chars", async () => {
  await withStore(({ addVoiceActivity }) => {
    const long = makeLongSentence(1500);
    assert.ok(long.length > 240);
    const event = addVoiceActivity({
      id: "run-1:complete",
      sessionId: "s",
      kind: "tool",
      state: "complete",
      title: "Hermes answered",
      summary: long,
      source: "voice/data",
    });
    assert.ok(
      event.summary.length > 240,
      `completion summary must exceed 240 chars, got ${event.summary.length}`,
    );
    assert.ok(
      event.summary.length >= 1400,
      "the full ~1500-char answer should survive (2000 cap)",
    );
    // Not truncated with the old ellipsis at 240.
    assert.ok(!event.summary.startsWith(long.slice(0, 239) + "…"));
  });
});

test("Law 8: a voice/action completion (error state) also gets the large cap", async () => {
  await withStore(({ addVoiceActivity }) => {
    const long = makeLongSentence(900);
    const event = addVoiceActivity({
      id: "run-2:failed",
      sessionId: "s",
      kind: "error",
      state: "error",
      title: "Hermes action failed",
      summary: long,
      source: "voice/action",
    });
    assert.ok(event.summary.length > 240, "error completions keep the full text too");
  });
});

test("Law 8: NOISE events (running/queued, non-completion sources) stay capped at 240", async () => {
  await withStore(({ addVoiceActivity }) => {
    const long = makeLongSentence(1500);

    // Running event on a completion lane: NOT complete/error → default cap.
    const running = addVoiceActivity({
      id: "run-3:running",
      sessionId: "s",
      kind: "tool",
      state: "active",
      title: "Working on that…",
      summary: long,
      source: "voice/action",
    });
    assert.ok(
      running.summary.length <= 240,
      `running event summary must stay ≤240, got ${running.summary.length}`,
    );

    // Completed but on a non-completion source (e.g. a generic voice log):
    // still the tight cap — only the two voice completion lanes get 2000.
    const log = addVoiceActivity({
      id: "log-1",
      sessionId: "s",
      kind: "log",
      state: "complete",
      title: "Voice",
      summary: long,
      source: "voice/stt",
    });
    assert.ok(
      log.summary.length <= 240,
      `non-completion-lane summary must stay ≤240, got ${log.summary.length}`,
    );
    assert.ok(log.summary.endsWith("…"), "capped noise summary keeps the ellipsis");
  });
});
