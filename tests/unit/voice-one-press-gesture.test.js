// tests/unit/voice-one-press-gesture.test.js
//
// T-0010 Law 1 — code-level guard that the WebKit-gated audio-stack activation
// happens INSIDE the user-gesture call stack, not deferred to the async
// effect-runner. WebKit (Safari / WKWebView / Tauri) only transitions an
// AudioContext to "running" when create + resume() run within the gesture; the
// old flow deferred them, which is why the app needed two presses.
//
// We can't spin a real WKWebView here, so we assert the STRUCTURE that makes
// one-press correct and lock it against regression:
//   1. VoiceProvider exposes primeAudioStack, and primeAudioStack calls
//      AudioContext.resume() and kicks getUserMedia.
//   2. The press handlers in VoiceDock call primeAudioStack synchronously, in
//      the gesture, before dispatching the toggle/PTT.
//   3. primeAudioStack is exposed through the voice context so the dock can
//      reach it.
//
// These are source-inspection assertions on purpose: they are the tightest
// executable contract for "resume() runs in the gesture" short of a browser,
// and they fail loudly if a refactor moves resume() back into the effect-runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const provider = fs.readFileSync(
  path.join(root, "components", "voice", "VoiceProvider.jsx"),
  "utf8",
);
const dock = fs.readFileSync(
  path.join(root, "components", "voice", "VoiceDock.jsx"),
  "utf8",
);

// Extract a top-level `const NAME = useCallback(( ... ) => { BODY }` block by
// brace-matching from the arrow so we reason about a single function's body.
function extractCallbackBody(source, name) {
  const anchor = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(anchor, -1, `expected a useCallback named ${name}`);
  const arrow = source.indexOf("=>", anchor);
  assert.notEqual(arrow, -1, `expected an arrow in ${name}`);
  const braceStart = source.indexOf("{", arrow);
  assert.notEqual(braceStart, -1, `expected a body brace in ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

test("primeAudioStack calls AudioContext.resume() (the in-gesture activation)", () => {
  const body = extractCallbackBody(provider, "primeAudioStack");
  assert.match(
    body,
    /\.resume\s*\(/,
    "primeAudioStack must call AudioContext.resume() so WebKit activates the context in-gesture",
  );
  assert.match(
    body,
    /new\s+Ctx\s*\(/,
    "primeAudioStack must create the AudioContext (in-gesture)",
  );
  assert.match(
    body,
    /getUserMedia/,
    "primeAudioStack must kick getUserMedia so the stream is primed in-gesture",
  );
});

test("primeAudioStack is a plain synchronous callback (no async/await deferral of resume)", () => {
  // It must NOT be async — an async primeAudioStack would resolve its body on a
  // microtask AFTER the gesture returns, defeating WebKit gesture activation.
  const anchor = provider.indexOf("const primeAudioStack = useCallback(");
  assert.notEqual(anchor, -1);
  const head = provider.slice(anchor, anchor + 60);
  assert.doesNotMatch(
    head,
    /useCallback\(\s*async/,
    "primeAudioStack must be synchronous so resume() runs inside the gesture stack",
  );
});

test("primeAudioStack is exposed through the voice context", () => {
  // Appears in the useMemo context value object.
  assert.match(
    provider,
    /\n\s*primeAudioStack,/,
    "primeAudioStack must be provided on the voice context so the dock can call it",
  );
});

test("accepted provider presses prime synchronously before START_PTT", () => {
  const body = extractCallbackBody(provider, "startPushToTalk");
  const primeAt = body.indexOf("primeAudioStack()");
  const dispatchAt = body.indexOf('dispatch({ type: "START_PTT"');
  assert.ok(primeAt > -1 && dispatchAt > primeAt);
  assert.doesNotMatch(body, /setTimeout|await/);
  const begin = extractCallbackBody(dock, "beginPtt");
  assert.match(begin, /startPushToTalk\(\)/);
  assert.doesNotMatch(begin, /setTimeout/);
});

test("continuous start owns its in-gesture priming for native and dock commands", () => {
  const body = extractCallbackBody(provider, "toggleContinuous");
  assert.ok(body.indexOf("primeAudioStack()") < body.indexOf('dispatch({ type: "TOGGLE_CONTINUOUS"'));
  assert.match(provider, /toggleContinuousRef\.current\?\.\(\)/);
});
