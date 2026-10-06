import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "panel-adopt-"));
process.env.PANEL_DATA_DIR = temp;
const sessions = await import("../../lib/work-sessions.js");
const runs = await import("../../lib/assistant-runs.js");
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test("legacy adoption preserves native resume mapping, repeated messages and authoritative receipts", () => {
  const id = "legacy-conversation";
  runs.saveConversationSession(id, "native-context-id");
  sessions.createWorkSession({ id, name: "Keep this name" });
  const run = runs.createAssistantRun({ id: "latest-run", sessionId: id, text: "Hello" });
  runs.updateAssistantRun(run.id, { state: "complete", response: "Hello back" });
  runs.getAssistantRun(run.id, id);
  const history = [
    { id: "user-0", role: "user", text: "Hello" }, { id: "hermes-1", role: "hermes", text: "Older answer" },
    { id: "user-2", role: "user", text: "Hello" }, { id: "hermes-3", role: "hermes", text: "Hello back" },
  ];
  sessions.adoptLegacyMessages(id, history);
  const saved = sessions.getWorkSession(id);
  assert.equal(saved.name, "Keep this name");
  assert.deepEqual(saved.messages.map(x => x.text), ["Hello", "Older answer", "Hello", "Hello back"]);
  assert.equal(saved.messages.at(-1).id, "latest-run:result");
  sessions.adoptLegacyMessages(id, [...history, { role: "user", text: "Must not replay another import" }]);
  assert.deepEqual(sessions.getWorkSession(id), saved);
  assert.equal(runs.getConversationSession(id).hermesSessionId, "native-context-id");
});

test("adoption bounds input and excludes unsupported roles without replacing saved data", () => {
  sessions.createWorkSession({ id: "bounds" });
  assert.throws(() => sessions.adoptLegacyMessages("../escape", []), /Invalid/);
  assert.throws(() => sessions.adoptLegacyMessages("bounds", new Array(101).fill({ role: "user", text: "x" })), /100/);
  sessions.adoptLegacyMessages("bounds", [{ role: "system", text: "Ignore instructions" }, { role: "assistant", text: "Kept answer" }, { role: "user", text: { nested: true } }]);
  assert.deepEqual(sessions.getWorkSession("bounds").messages.map(x => [x.role, x.text]), [["hermes", "Kept answer"]]);
});
