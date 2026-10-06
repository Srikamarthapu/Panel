import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVoiceIntent,
  dataLaneFiller,
  dataLaneStatusLabel,
  actionStatusLabel,
} from "../../lib/voice.js";

// T-0008 fix A — the three-lane router. classifyVoiceIntent stays a
// deterministic regex/keyword classifier (no LLM) with three outcomes:
//   chat   — default fast path, no tools
//   action — command-verb utterances, detached hermes run
//   data   — personal-data questions, filler + tool-backed hermes run

test("chat lane: conversational utterances with no personal-data noun", () => {
  const cases = [
    "what changed in the design",
    "tell me a joke",
    "how does photosynthesis work",
    "what is the capital of France",
    "explain the voice pipeline",
  ];
  for (const text of cases) {
    const intent = classifyVoiceIntent(text);
    assert.equal(intent.type, "chat", `expected chat for: ${text}`);
    assert.equal(intent.action, false, `chat must not be an action: ${text}`);
  }
});

test("action lane: command-verb utterances stay actions (unchanged behavior)", () => {
  const cases = [
    "run the unit tests",
    "can you check the build",
    "please deploy the app",
    "hermes, restart the server",
    "open notion",
    "open the browser",
  ];
  for (const text of cases) {
    const intent = classifyVoiceIntent(text);
    assert.equal(intent.type, "action", `expected action for: ${text}`);
    assert.equal(intent.action, true, `action lane sets action=true: ${text}`);
    assert.ok(intent.statusLabel, `action carries a status label: ${text}`);
  }
});

test("data lane: the user's exact complaint routes to data, not chat", () => {
  // This is complaint A verbatim. Before T-0008 it fell through to the bare
  // fast path (flash, no tools) and hallucinated.
  const intent = classifyVoiceIntent("what do I have on my calendar?");
  assert.equal(intent.type, "data");
  assert.equal(intent.action, true);
  assert.equal(intent.dataTopic, "calendar");
  assert.ok(intent.filler, "data lane carries a spoken filler");
  assert.ok(intent.statusLabel, "data lane carries a present-tense status label");
});

test("data lane: personal-data questions across topics route to data", () => {
  const cases = [
    ["what's on my calendar today", "calendar"],
    ["what meetings do I have", "calendar"],
    ["do I have any appointments tomorrow", "calendar"],
    ["check my email", "email"],
    ["any new emails", "email"],
    ["what's in my inbox", "email"],
    ["find my notion notes on the project", "notion"],
    ["what's on my task list", "tasks"],
    ["what are my reminders", "tasks"],
    ["show me my downloads", "files"],
  ];
  for (const [text, topic] of cases) {
    const intent = classifyVoiceIntent(text);
    assert.equal(intent.type, "data", `expected data lane for: ${text}`);
    assert.equal(intent.dataTopic, topic, `wrong topic for: ${text}`);
    assert.equal(intent.action, true, `data lane sets action=true: ${text}`);
  }
});

test("data lane precedence: command verbs win over data nouns", () => {
  // "open notion" is a direct action, not a data question, even though it
  // contains a personal-data noun. The command-verb check runs first.
  assert.equal(classifyVoiceIntent("open notion").type, "action");
  assert.equal(classifyVoiceIntent("open my calendar").type, "action");
});

test("data lane requires a question/request shape, not a bare noun", () => {
  // A bare topic noun with no question/possessive/request signal is NOT
  // enough to hijack the chat lane (avoid over-routing generic chatter).
  assert.equal(classifyVoiceIntent("calendars are a useful invention").type, "chat");
  assert.equal(classifyVoiceIntent("email as a technology is old").type, "chat");
});

test("dataLaneFiller returns a spoken, TTS-safe line per topic", () => {
  assert.match(dataLaneFiller("calendar"), /calendar/i);
  assert.match(dataLaneFiller("email"), /inbox|email/i);
  assert.match(dataLaneFiller("notion"), /notion/i);
  // Unknown topic falls back to a generic line, never empty.
  assert.ok(dataLaneFiller("unknown-topic").trim().length > 0);
  // No markup that TTS would read literally.
  for (const t of ["calendar", "email", "notion", "tasks", "files", "personal"]) {
    assert.doesNotMatch(dataLaneFiller(t), /[*_`#\[\]]/, `filler for ${t} has markup`);
  }
});

test("dataLaneStatusLabel returns a present-tense label per topic", () => {
  assert.match(dataLaneStatusLabel("calendar"), /Checking your calendar/i);
  assert.match(dataLaneStatusLabel("email"), /inbox/i);
  // Present-tense labels end with an ellipsis to read as in-flight.
  for (const t of ["calendar", "email", "notion", "tasks", "files", "personal"]) {
    assert.match(dataLaneStatusLabel(t), /…$/, `label for ${t} not present-tense`);
  }
});

test("actionStatusLabel derives a present-tense label from the utterance", () => {
  assert.match(actionStatusLabel("open notion"), /Opening Notion…/);
  assert.match(actionStatusLabel("open the browser"), /Opening Browser…/);
  assert.match(actionStatusLabel("run the tests"), /Running/);
  assert.match(actionStatusLabel("build the project"), /Building/);
  assert.match(actionStatusLabel("check the lint"), /Checking/);
  // Always non-empty and present-tense.
  assert.match(actionStatusLabel("restart the server"), /…$/);
  assert.match(actionStatusLabel(""), /…$/);
});
