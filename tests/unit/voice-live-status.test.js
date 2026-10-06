import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectLiveStatus } from "../../components/voice/voiceActivityTicker.js";

// T-0008 fix C — while a detached action/data run is in flight the dock shows
// its present-tense label ("Checking your calendar…"), overriding historical
// rotation; the moment the run finishes the live status clears.

function ev(id, { state, source = "voice/data", title = "", sessionId = "s1", at = "2026-07-05T12:00:00.000Z" } = {}) {
  return { id, state, source, title, sessionId, updatedAt: at };
}

test("selectLiveStatus returns the present-tense label of an in-flight run", () => {
  const activity = [
    ev("run1", { state: "queued", title: "Checking your calendar…" }),
  ];
  const live = selectLiveStatus(activity, { sessionId: "s1" });
  assert.ok(live);
  assert.equal(live.label, "Checking your calendar…");
  assert.equal(live.runId, "run1");
});

test("selectLiveStatus prefers the active (running) event over the queued one", () => {
  const activity = [
    ev("run1:running", { state: "active", title: "Opening Notion…", at: "2026-07-05T12:00:02.000Z" }),
    ev("run1", { state: "queued", title: "Opening Notion…", at: "2026-07-05T12:00:00.000Z" }),
  ];
  const live = selectLiveStatus(activity, { sessionId: "s1" });
  assert.equal(live.state, "active");
  assert.equal(live.runId, "run1");
});

test("selectLiveStatus clears once the run has a completion event", () => {
  const activity = [
    ev("run1:complete", { state: "complete", title: "Hermes answered", at: "2026-07-05T12:00:10.000Z", source: "voice/data" }),
    ev("run1:running", { state: "active", title: "Checking your calendar…", at: "2026-07-05T12:00:02.000Z", source: "voice/data" }),
    ev("run1", { state: "queued", title: "Checking your calendar…", at: "2026-07-05T12:00:00.000Z", source: "voice/data" }),
  ];
  // The finished run must NOT produce a live status — back to normal rotation.
  assert.equal(selectLiveStatus(activity, { sessionId: "s1" }), null);
});

test("selectLiveStatus shows a newer run while an older one is still finishing", () => {
  const activity = [
    ev("run2:running", { state: "active", title: "Opening Notion…", at: "2026-07-05T12:00:20.000Z", source: "voice/action" }),
    ev("run1:complete", { state: "complete", title: "Hermes answered", at: "2026-07-05T12:00:10.000Z", source: "voice/data" }),
    ev("run1", { state: "queued", title: "Checking your calendar…", at: "2026-07-05T12:00:00.000Z", source: "voice/data" }),
  ];
  const live = selectLiveStatus(activity, { sessionId: "s1" });
  assert.equal(live.runId, "run2");
  assert.equal(live.label, "Opening Notion…");
});

test("selectLiveStatus ignores non-voice-lane and other-session events", () => {
  const activity = [
    ev("x", { state: "active", title: "unrelated", source: "hermes/tool" }),
    ev("y", { state: "queued", title: "other session", sessionId: "s2" }),
  ];
  assert.equal(selectLiveStatus(activity, { sessionId: "s1" }), null);
});

test("selectLiveStatus returns null when nothing is in flight", () => {
  assert.equal(selectLiveStatus([], { sessionId: "s1" }), null);
  assert.equal(selectLiveStatus(null, { sessionId: "s1" }), null);
});

test("shared runtime status uses the bounded control-center subscription", () => {
  const dock = readFileSync(resolve("components/voice/VoiceDock.jsx"), "utf8");
  assert.doesNotMatch(dock, /<VoiceActivityTicker/);
  const runtime = readFileSync(resolve("components/control/RuntimeProvider.jsx"), "utf8");
  assert.match(runtime, /fetch\("\/api\/control-center"/);
  assert.doesNotMatch(runtime, /\/api\/mission-control/);
});
