// T-0009 fix B — session-stability leak regressions.
//
// The client degraded across turns until a reload. These are static-source
// regression guards for the confirmed cumulative-state leaks in
// components/voice/VoiceProvider.jsx. The repo has no jsdom harness (every
// "property" test is a pure-rule simulation), and the leaks live in the
// imperative React shell, so we assert on the source the same way
// voice-fast-path.test.js asserts the route never spawns Hermes.
//
// Each assertion pins a specific fix so a future refactor that reintroduces
// the leak fails loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve("components/voice/VoiceProvider.jsx"), "utf8");

test("playback teardown ref exists and is invoked on barge-in / stop / unmount", () => {
  // The single teardown handle for the currently-playing clip.
  assert.match(
    src,
    /currentPlaybackCleanupRef\s*=\s*useRef\(null\)/,
    "expected a currentPlaybackCleanupRef to hold the active clip's teardown",
  );
  // stopAudio (barge-in) must invoke it so the stall interval + stream reader
  // don't survive into the next turn.
  const start = src.indexOf("const stopAudio =");
  const stopAudioBody = src.slice(start, src.indexOf("// ---------- effect runner", start));
  assert.match(
    stopAudioBody,
    /currentPlaybackCleanupRef\.current\(\)/,
    "stopAudio must run the active playback cleanup (clears stall interval + reader)",
  );
  assert.match(stopAudioBody, /ttsPrefetchRef\.current\?\.controller\.abort\(\)/, "stopAudio must cancel the next sentence as well as current playback");
  // At least three call sites: playAudio (pre-empt prior), stopAudio, unmount.
  const invocations = src.match(/currentPlaybackCleanupRef\.current\(\)/g) || [];
  assert.ok(
    invocations.length >= 3,
    `expected the cleanup invoked from playAudio, stopAudio, and unmount; found ${invocations.length}`,
  );
});

test("the stall interval is cleared through the single teardown, not left dangling", () => {
  // There must be exactly one clearInterval(stallId), inside teardownPlayback,
  // instead of the old scattered clearInterval calls that barge-in bypassed.
  const clears = src.match(/clearInterval\(stallId\)/g) || [];
  assert.equal(
    clears.length,
    1,
    `stall interval should be cleared in exactly one place (teardownPlayback); found ${clears.length}`,
  );
  assert.match(src, /const teardownPlayback = \(\) => \{[\s\S]*?clearInterval\(stallId\)/, "clearInterval(stallId) must live inside teardownPlayback");
});

test("the MediaSource stream reader is cancellable on barge-in", () => {
  // cancelStream lets teardownPlayback abort the reader so it can't keep
  // pumping bytes into a MediaSource nobody is playing after a barge-in.
  assert.match(src, /cancelStream\s*=\s*\(\)\s*=>/, "expected a cancelStream closure over the reader");
  assert.match(
    src,
    /const teardownPlayback = \(\) => \{[\s\S]*?cancelStream\(\)/,
    "teardownPlayback must cancel the stream reader",
  );
});

test("unbounded per-turn collections are all capped", () => {
  // revokedURLs Set — capped.
  assert.match(src, /REVOKED_URL_CAP/, "revokedURLs must be bounded");
  assert.match(src, /revokedURLs\.size > REVOKED_URL_CAP[\s\S]*?revokedURLs\.delete/, "revokedURLs must evict its oldest entry past the cap");
  // recentSummariesRef Map — capped + LRU re-insert.
  assert.match(src, /RECENT_SUMMARIES_CAP/, "recentSummaries map must be bounded");
  assert.match(src, /map\.size > RECENT_SUMMARIES_CAP[\s\S]*?map\.delete/, "recentSummaries must evict its oldest entry past the cap");
  // spokenCompletionIdsRef Set — capped.
  assert.match(
    src,
    /spokenCompletionIdsRef\.current\.size > \d+[\s\S]*?spokenCompletionIdsRef\.current\.delete/,
    "spoken-completion ids must be bounded",
  );
});

test("the dead mountedURLs WeakSet was removed (it tracked throwaway objects)", () => {
  // The old code did `mountedURLs.add({ url })` into a WeakSet — a no-op that
  // never actually tracked anything. It must be gone.
  assert.doesNotMatch(src, /mountedURLs/, "the dead mountedURLs WeakSet must be removed");
});
