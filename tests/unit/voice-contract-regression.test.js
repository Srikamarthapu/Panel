import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const voiceLib = readFileSync(resolve("lib/voice.js"), "utf8");
const harness = readFileSync(resolve("scripts/voice/fast-path-harness.mjs"), "utf8");

test("T-0006 timing harness observes subprocess attempts instead of hard-coding zero", () => {
  assert.doesNotMatch(
    harness,
    /hermes_spawn_calls_in_fast_path\s*:\s*0\b/,
    "harness must prove zero Hermes spawns by observing child_process usage, not by returning a literal zero",
  );
  assert.match(
    harness,
    /child_process|spawn|execFile/,
    "harness needs a spawn/exec guard so a regression to hermes chat would fail the harness",
  );
});

test("T-0006 direct voice model prompt includes Hermes memory snapshot sources", () => {
  assert.match(voiceLib, /USER\.md/);
  assert.match(voiceLib, /MEMORY\.md/);
  assert.match(voiceLib, /getVoiceSystemPromptWithMemory/);
  assert.match(voiceLib, /messages:\s*\[\s*\{\s*role:\s*"system",\s*content:\s*systemPrompt\s*\}/);
});
