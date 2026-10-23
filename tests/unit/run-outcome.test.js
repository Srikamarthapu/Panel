import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-outcomes-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "store");
process.env.HERMES_HOME = path.join(temporary, "hermes-home");
const outcomes = await import("../../lib/run-outcome.js");
const sessions = await import("../../lib/work-sessions.js");
const runs = await import("../../lib/assistant-runs.js");
const queue = await import("../../lib/work-queue.js");
const voiceMachine = await import("../../components/voice/voiceMachine.js");

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("outcomes retain structured receipts without parsing prose or tool payloads", () => {
  let receipts = [];
  receipts = outcomes.mergeToolReceipt(receipts, { toolCallId: "one", kind: "edit", status: "in_progress", locations: [{ path: "/project/src/app.js", line: 9 }], rawInput: { command: "secret" } }, "2026-10-13T10:00:00.000Z");
  receipts = outcomes.mergeToolReceipt(receipts, { toolCallId: "one", kind: "edit", status: "completed", rawOutput: "private contents" }, "2026-10-13T10:00:01.000Z");
  receipts = outcomes.mergeToolReceipt(receipts, { toolCallId: "one", kind: "edit", status: "in_progress" }, "2026-10-13T10:00:02.000Z");
  const outcome = outcomes.createRunOutcome({
    state: "complete",
    response: "I changed /unverified/from-prose.js and included SECRET prose.",
    updatedAt: "2026-10-13T10:00:03.000Z",
    selectedModel: "runtime-model",
    selectedProvider: "provider",
    selectedModelProvenance: "runtime",
    outcomeEvidence: { toolReceipts: receipts },
  });
  assert.equal(outcome.observed.tools[0].status, "completed");
  assert.equal(outcome.observed.tools[0].finishedAt, "2026-10-13T10:00:01.000Z");
  assert.deepEqual(outcome.observed.files.map(item => item.path), ["/project/src/app.js"]);
  assert.deepEqual(outcome.verified.items.map(item => [item.path, item.source]), [["/project/src/app.js", "runtime_receipt"]]);
  assert.equal(JSON.stringify(outcome).includes("secret"), false);
  assert.equal(JSON.stringify(outcome).includes("/unverified/from-prose.js"), true, "agent prose stays a labeled summary, never file evidence");
  assert.deepEqual(outcome.runtime, { model: "runtime-model", provider: "provider", provenance: "runtime" });
  assert.deepEqual(outcome.model, { requested: null, reported: { model: "runtime-model", provider: "provider", provenance: "runtime" }, mismatch: false });
});

test("bounded receipt updates preserve the complete inventory", () => {
  let receipts = [];
  for (let index = 0; index < 32; index++) receipts = outcomes.mergeToolReceipt(receipts, { toolCallId: `tool-${index}`, kind: "read", status: "in_progress" });
  receipts = outcomes.mergeToolReceipt(receipts, { toolCallId: "tool-0", kind: "read", status: "completed" });
  assert.equal(receipts.length, 32);
  assert.equal(receipts.find(item => item.callId === "tool-0").status, "completed");
  assert.ok(receipts.some(item => item.callId === "tool-31"));
});

test("requested-only routes never claim a runtime mismatch", () => {
  const requested = outcomes.createRunOutcome({ state: "complete", response: "Done.", requestedProvider: "provider-a", requestedModel: "model-a" });
  assert.deepEqual(requested.model, { requested: { provider: "provider-a", model: "model-a" }, reported: null, mismatch: null });
  assert.equal(outcomes.normalizeRunOutcome(requested).model.mismatch, null);
});

test("verified evidence and compact projections remain bounded under adversarial input", () => {
  const verifiedItems = Array.from({ length: 24 }, (_, index) => ({ kind: "artifact", path: `/project/artifacts/item-${index}.json`, source: "post_run_check", label: `artifact ${index}` }));
  const toolReceipts = Array.from({ length: 32 }, (_, index) => ({ toolCallId: `edit-${index}`, kind: "edit", status: "completed", locations: [{ path: `/project/src/file-${index}.js` }] }));
  const outcome = outcomes.createRunOutcome({ state: "complete", response: "Done.", updatedAt: "2026-10-13T10:00:00.000Z", outcomeEvidence: { verifiedItems, toolReceipts } });
  assert.equal(outcome.verified.items.length, 24);
  assert.equal(outcome.observed.files.length, 24);
  const compact = outcomes.compactRunOutcome(outcome);
  assert.equal(compact.observed.tools.length, 12);
  assert.equal(compact.observed.files.length, 8);
  assert.equal(compact.verified.items.length, 8);
});

test("assistant runs persist outcome review in public receipts and session history", () => {
  const folder = path.join(temporary, "project");
  fs.mkdirSync(folder, { recursive: true });
  const session = sessions.createWorkSession({ id: "outcome-session", name: "Outcome", workingDirectory: folder });
  const run = runs.createAssistantRun({ id: "outcome-run", sessionId: session.id, text: "Update the file", requestedProvider: "deepseek", requestedModel: "requested-model" });
  runs.recordAssistantRunToolEvent(run.id, { toolCallId: "edit-1", kind: "edit", status: "in_progress", locations: [{ path: "src/index.js", line: 3 }], rawInput: { command: "must-not-persist" } });
  runs.recordAssistantRunToolEvent(run.id, { toolCallId: "edit-1", kind: "edit", status: "completed", rawOutput: "must-not-persist" });
  runs.updateAssistantRun(run.id, { selectedProvider: "deepseek", selectedModel: "actual-model", selectedModelProvenance: "runtime" });
  const completed = runs.updateAssistantRun(run.id, { state: "complete", response: "Finished." });
  const publicRun = runs.publicAssistantRun(completed);
  assert.equal(publicRun.outcome.runtime.model, "actual-model");
  assert.deepEqual(publicRun.outcome.model, { requested: { provider: "deepseek", model: "requested-model" }, reported: { provider: "deepseek", model: "actual-model", provenance: "runtime" }, mismatch: true });
  assert.deepEqual(publicRun.outcome.verified.items.map(item => item.path), [path.join(fs.realpathSync(folder), "src/index.js")]);
  assert.equal(JSON.stringify(completed).includes("must-not-persist"), false);
  const result = sessions.getWorkSession(session.id).messages.find(message => message.id === `${run.id}:result`);
  assert.equal(result.outcome.version, 1);
  assert.equal(result.outcome.summary.provenance, "agent");
});

test("failed legacy results remain reviewable with runtime provenance and unavailable evidence", () => {
  const outcome = outcomes.outcomeFromLegacyResult({ state: "interrupted", error: "Provider connection stopped.", updatedAt: "2026-10-13T10:00:00.000Z" });
  assert.equal(outcome.summary.provenance, "runtime");
  assert.equal(outcome.verified.status, "unavailable");
  assert.match(outcome.verified.note, /did not receive/);
});

test("late failures persist a bounded partial answer separately from the failed terminal receipt", () => {
  const session = sessions.createWorkSession({ id: "partial-failure-session", name: "Partial failure" });
  const run = runs.createAssistantRun({ id: "partial-failure-run", sessionId: session.id, text: "Say hello" });
  const failed = runs.updateAssistantRun(run.id, { state: "error", response: "", partialResponse: "A useful answer arrived first.", error: "Hermes did not confirm completion." });
  const publicRun = runs.publicAssistantRun(failed);
  assert.equal(publicRun.state, "error");
  assert.equal(publicRun.response, "");
  assert.equal(publicRun.partialResponse, "A useful answer arrived first.");

  const messages = sessions.getWorkSession(session.id).messages;
  const partial = messages.find(message => message.id === `${run.id}:partial`);
  const error = messages.find(message => message.id === `${run.id}:result`);
  assert.deepEqual({ text: partial.text, partialResponse: partial.partialResponse, interrupted: partial.interrupted, runId: partial.runId }, {
    text: "A useful answer arrived first.", partialResponse: true, interrupted: true, runId: undefined,
  });
  assert.equal(error.runId, run.id);
  assert.equal(error.isError, true);
  assert.equal(error.text, "Hermes did not confirm completion.");
});

test("a stopping outcome becomes stopped after queue reconciliation", async () => {
  const session = sessions.createWorkSession({ id: "stop-session", name: "Stop" });
  const task = queue.createWorkTask({ sessionId: session.id, prompt: "Stop safely" });
  const file = path.join(process.env.PANEL_DATA_DIR, "work-queue.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  store.tasks[0] = { ...store.tasks[0], state: "cancelled", outcome: outcomes.createRunOutcome({ state: "cancelled", error: "Stop requested.", updatedAt: new Date().toISOString(), executionActive: true, executionCancelRequestedAt: new Date().toISOString() }) };
  fs.writeFileSync(file, JSON.stringify(store));
  assert.equal(queue.getWorkTask(task.id).outcome.execution.stopping, true);
  await queue.tickWorkQueue({ getRun: () => ({ id: task.runId, sessionId: session.id, state: "cancelled", error: "Stopped.", updatedAt: new Date().toISOString(), executionActive: false, executionFinishedAt: new Date().toISOString() }), isExecuting: () => false });
  assert.deepEqual(queue.getWorkTask(task.id).outcome.execution, { active: false, stopping: false });
});

test("live completion carries outcome metadata into successful and failed transcript entries", () => {
  const complete = outcomes.outcomeFromLegacyResult({ state: "complete", response: "Done.", updatedAt: "2026-10-13T10:00:00.000Z" });
  let wrapper = { state: { ...voiceMachine.initialWrapper.state, state: "idle", transcriptHydrated: true, transcript: [], config: { ...voiceMachine.initialWrapper.state.config, autoSpeak: false } }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "SPEAK_COMPLETION", text: "Done.", textOnly: true, entryId: "complete", outcome: complete });
  assert.equal(wrapper.state.transcript[0].outcome.state, "complete");
  const failed = outcomes.outcomeFromLegacyResult({ state: "interrupted", error: "Connection stopped.", updatedAt: "2026-10-13T10:00:01.000Z" });
  wrapper = voiceMachine.reducer(wrapper, { type: "SPEAK_COMPLETION", text: "Connection stopped.", textOnly: true, isError: true, entryId: "failed", outcome: failed });
  assert.equal(wrapper.state.transcript[1].isError, true);
  assert.equal(wrapper.state.transcript[1].outcome.state, "interrupted");
});

test("a reconciled terminal run refreshes the existing transcript outcome in place", () => {
  const stopping = outcomes.createRunOutcome({ state: "cancelled", error: "Stop requested.", executionActive: true, executionCancelRequestedAt: "2026-10-13T10:00:00.000Z" });
  let wrapper = { state: { ...voiceMachine.initialWrapper.state, state: "idle", transcriptHydrated: true, transcript: [], config: { ...voiceMachine.initialWrapper.state.config, autoSpeak: false } }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "SPEAK_COMPLETION", actionId: "run-stop", text: "Stop requested.", textOnly: true, isError: true, entryId: "stop-result", outcome: stopping });
  assert.equal(wrapper.state.transcript[0].outcome.execution.stopping, true);
  const stopped = outcomes.createRunOutcome({ state: "cancelled", error: "Stopped.", updatedAt: "2026-10-13T10:00:01.000Z", executionActive: false });
  wrapper = voiceMachine.reducer(wrapper, { type: "UPDATE_RUN_OUTCOME", actionId: "run-stop", outcome: stopped });
  assert.equal(wrapper.state.transcript.length, 1);
  assert.deepEqual(wrapper.state.transcript[0].outcome.execution, { active: false, stopping: false });
});

test("server history reconciliation merges terminal receipts without disturbing live voice state", () => {
  const stopping = outcomes.createRunOutcome({ state: "cancelled", error: "Stop requested.", executionActive: true, executionCancelRequestedAt: "2026-10-13T10:00:00.000Z" });
  const stopped = outcomes.createRunOutcome({ state: "cancelled", error: "Stopped.", updatedAt: "2026-10-13T10:00:01.000Z", executionActive: false });
  const external = outcomes.createRunOutcome({ state: "complete", response: "External work finished.", updatedAt: "2026-10-13T10:00:02.000Z" });
  const pending = { id: "stream-current", role: "hermes", text: "Still speaking", pending: true };
  let wrapper = { state: {
    ...voiceMachine.initialWrapper.state,
    state: "capturing",
    transcriptHydrated: true,
    actionId: "current-run",
    requestPending: true,
    transcript: [
      { id: "user-local", role: "user", runId: "run-stop", text: "Stop that run" },
      { id: "completion-run-stop:failed", role: "hermes", runId: "run-stop", text: "Stop requested.", outcome: stopping, audioUrl: "blob:local" },
      pending,
    ],
  }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "run-stop:user", role: "user", runId: "run-stop", text: "Stop that run" },
    { id: "run-stop:result", role: "hermes", runId: "run-stop", text: "Stopped.", outcome: stopped, isError: true },
    { id: "external-run:user", role: "user", runId: "external-run", text: "Finish the external task" },
    { id: "external-run:result", role: "hermes", runId: "external-run", text: "External work finished.", outcome: external },
    { id: "current-run:user", role: "user", runId: "current-run", text: "Still active" },
  ] });
  assert.equal(wrapper.state.state, "capturing");
  assert.equal(wrapper.state.requestPending, true);
  assert.equal(wrapper.effects.length, 0);
  assert.equal(wrapper.state.transcript.filter(entry => entry.role === "hermes" && entry.runId === "run-stop").length, 1);
  assert.equal(wrapper.state.transcript[0].runId, "run-stop");
  assert.equal(wrapper.state.transcript[1].id, "completion-run-stop:failed");
  assert.equal(wrapper.state.transcript[1].audioUrl, "blob:local");
  assert.equal(wrapper.state.transcript[1].text, "Stopped.");
  assert.deepEqual(wrapper.state.transcript[1].outcome.execution, { active: false, stopping: false });
  assert.strictEqual(wrapper.state.transcript[2], pending);
  assert.deepEqual(wrapper.state.transcript.slice(-2).map(entry => [entry.role, entry.runId]), [["user", "external-run"], ["hermes", "external-run"]]);
  assert.equal(wrapper.state.transcript.some(entry => entry.runId === "current-run"), false);
});

test("server history reconciliation waits for a terminal pair and remains idempotent across races", () => {
  const activeUser = { id: "late-run:user", role: "user", runId: "late-run", text: "Saved outside this tab" };
  let wrapper = { state: { ...voiceMachine.initialWrapper.state, transcriptHydrated: true, transcript: [] }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [activeUser] });
  assert.deepEqual(wrapper.state.transcript, []);
  const complete = outcomes.createRunOutcome({ state: "complete", response: "Saved result.", updatedAt: "2026-10-13T10:00:03.000Z" });
  const terminalSnapshot = [activeUser, { id: "late-run:result", role: "hermes", runId: "late-run", text: "Saved result.", outcome: complete }];
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: terminalSnapshot });
  assert.deepEqual(wrapper.state.transcript.map(entry => entry.id), ["late-run:user", "late-run:result"]);
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: terminalSnapshot });
  assert.deepEqual(wrapper.state.transcript.map(entry => entry.id), ["late-run:user", "late-run:result"]);
  assert.equal(wrapper.effects.length, 0);
});

test("server reconciliation restores a missing prompt before an existing external result", () => {
  const complete = outcomes.createRunOutcome({ state: "complete", response: "External result.", updatedAt: "2026-10-13T10:00:04.000Z" });
  let wrapper = { state: {
    ...voiceMachine.initialWrapper.state,
    transcriptHydrated: true,
    actionId: "another-run",
    transcript: [{ id: "completion-external:complete", role: "hermes", runId: "external", text: "External result." }],
  }, effects: [] };
  const snapshot = [
    { id: "external:user", role: "user", runId: "external", text: "External prompt" },
    { id: "external:result", role: "hermes", runId: "external", text: "External result.", outcome: complete },
  ];
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: snapshot });
  assert.deepEqual(wrapper.state.transcript.map(entry => [entry.role, entry.runId]), [["user", "external"], ["hermes", "external"]]);
  assert.equal(wrapper.state.transcript[1].id, "completion-external:complete");
  assert.equal(wrapper.state.transcript[1].outcome.state, "complete");
  assert.equal(wrapper.effects.length, 0);
});

test("a server result arriving before the local completion finishes once without duplication", () => {
  const complete = outcomes.createRunOutcome({ state: "complete", response: "One result.", updatedAt: "2026-10-13T10:00:05.000Z" });
  let wrapper = { state: {
    ...voiceMachine.initialWrapper.state,
    state: "thinking",
    transcriptHydrated: true,
    transcript: [{ id: "local-user", role: "user", text: "Local prompt" }],
  }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "CHAT_PENDING", actionId: "local-run" });
  assert.equal(wrapper.state.transcript[0].runId, "local-run");
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "local-run:user", role: "user", runId: "local-run", text: "Local prompt" },
    { id: "local-run:result", role: "hermes", runId: "local-run", text: "One result.", outcome: complete },
  ] });
  assert.deepEqual(wrapper.state.transcript.map(entry => [entry.role, entry.runId]), [["user", "local-run"], ["hermes", "local-run"]]);
  assert.equal(wrapper.state.requestPending, true);
  assert.equal(wrapper.effects.length, 0);
  wrapper = voiceMachine.reducer(wrapper, { type: "SPEAK_COMPLETION", actionId: "local-run", entryId: "completion-local-run:complete", text: "One result.", outcome: complete });
  assert.equal(wrapper.state.transcript.filter(entry => entry.role === "hermes" && entry.runId === "local-run").length, 1);
  assert.equal(wrapper.state.requestPending, false);
  assert.deepEqual(wrapper.effects.map(effect => effect.kind), ["callTTS"]);
});

test("a direct response keeps one stable result when durable history catches up", () => {
  let wrapper = { state: {
    ...voiceMachine.initialWrapper.state,
    state: "thinking",
    transcriptHydrated: true,
    transcript: [{ id: "direct-user", role: "user", text: "Direct prompt" }],
  }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "CHAT_PENDING", actionId: "direct-run" });
  wrapper = voiceMachine.reducer(wrapper, {
    type: "CHAT_OK",
    actionId: "direct-run",
    id: "direct-run:result",
    response: "Direct result.",
    textOnly: true,
  });
  assert.deepEqual(wrapper.state.transcript.map(entry => [entry.role, entry.runId, entry.id]), [
    ["user", "direct-run", "direct-user"],
    ["hermes", "direct-run", "direct-run:result"],
  ]);
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "direct-run:user", role: "user", runId: "direct-run", text: "Direct prompt" },
    { id: "direct-run:result", role: "hermes", runId: "direct-run", text: "Direct result." },
  ] });
  assert.equal(wrapper.state.transcript.filter(entry => entry.role === "hermes" && entry.runId === "direct-run").length, 1);
  assert.equal(wrapper.effects.length, 0);
});

test("CHAT_PENDING binds only the exact newest user when repeated prompts have older server rows", () => {
  let wrapper = { state: {
    ...voiceMachine.initialWrapper.state,
    transcriptHydrated: true,
    actionId: "old-run",
    requestPending: false,
    transcript: [
      { id: "older-user", role: "user", runId: "old-run", text: "Repeat this" },
      { id: "older-result", role: "hermes", runId: "old-run", text: "Older result" },
      { id: "current-user", role: "user", text: "Repeat this" },
    ],
  }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "CHAT_PENDING", actionId: "current-run" });
  assert.deepEqual(wrapper.state.transcript.filter(entry => entry.role === "user").map(entry => [entry.id, entry.runId]), [
    ["older-user", "old-run"],
    ["current-user", "current-run"],
  ]);
  const older = outcomes.createRunOutcome({ state: "complete", response: "Older result", updatedAt: "2026-10-13T10:00:00.000Z" });
  const current = outcomes.createRunOutcome({ state: "complete", response: "Current result", updatedAt: "2026-10-13T10:00:01.000Z" });
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "old-run:user", role: "user", runId: "old-run", text: "Repeat this" },
    { id: "old-run:result", role: "hermes", runId: "old-run", text: "Older result", outcome: older },
    { id: "current-run:user", role: "user", runId: "current-run", text: "Repeat this" },
    { id: "current-run:result", role: "hermes", runId: "current-run", text: "Current result", outcome: current },
  ] });
  assert.deepEqual(wrapper.state.transcript.filter(entry => entry.role === "user").map(entry => [entry.id, entry.runId]), [
    ["older-user", "old-run"],
    ["current-user", "current-run"],
  ]);
  assert.equal(wrapper.state.transcript.filter(entry => entry.role === "user").length, 2);
});

test("same-run receipt reconciliation never regresses a final stop across arrival orders", () => {
  const stopping = outcomes.createRunOutcome({ state: "cancelled", error: "Stop requested.", executionActive: true, executionCancelRequestedAt: "2026-10-13T10:00:05.000Z" });
  const stopped = outcomes.createRunOutcome({ state: "cancelled", error: "Stopped.", updatedAt: "2026-10-13T10:00:06.000Z", executionActive: false });
  let wrapper = { state: {
    ...voiceMachine.initialWrapper.state,
    state: "thinking",
    transcriptHydrated: true,
    transcript: [{ id: "stop-user", role: "user", text: "Stop" }],
  }, effects: [] };
  wrapper = voiceMachine.reducer(wrapper, { type: "CHAT_PENDING", actionId: "stop-race" });
  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "stop-race:user", role: "user", runId: "stop-race", text: "Stop" },
    { id: "stop-race:result", role: "hermes", runId: "stop-race", text: "Stop requested.", outcome: stopping, isError: true },
  ] });
  assert.equal(wrapper.state.transcript[1].outcome.execution.stopping, true);
  wrapper = voiceMachine.reducer(wrapper, { type: "SPEAK_COMPLETION", actionId: "stop-race", entryId: "completion-stop-race:failed", text: "Stopped.", outcome: stopped, isError: true });
  assert.equal(wrapper.state.transcript.filter(entry => entry.role === "hermes" && entry.runId === "stop-race").length, 1);
  assert.equal(wrapper.state.transcript[1].text, "Stopped.");
  assert.deepEqual(wrapper.state.transcript[1].outcome.execution, { active: false, stopping: false });

  wrapper = voiceMachine.reducer(wrapper, { type: "RECONCILE_SERVER_TRANSCRIPT", entries: [
    { id: "stop-race:user", role: "user", runId: "stop-race", text: "Stop" },
    { id: "stop-race:result", role: "hermes", runId: "stop-race", text: "Stop requested.", outcome: stopping, isError: true },
  ] });
  assert.equal(wrapper.state.transcript[1].text, "Stopped.");
  assert.deepEqual(wrapper.state.transcript[1].outcome.execution, { active: false, stopping: false });
  wrapper = voiceMachine.reducer(wrapper, { type: "UPDATE_RUN_OUTCOME", actionId: "stop-race", outcome: stopping });
  assert.deepEqual(wrapper.state.transcript[1].outcome.execution, { active: false, stopping: false });
});

test("legacy browser adoption cannot supply verified runtime evidence", () => {
  const session = sessions.createWorkSession({ id: "adopt-outcome", name: "Adopt" });
  sessions.adoptLegacyMessages(session.id, [{
    id: "browser-result",
    runId: "claimed-server-run",
    role: "hermes",
    text: "Claimed result.",
    outcome: {
      version: 1,
      state: "complete",
      summary: { text: "Claimed result.", provenance: "agent" },
      observed: { tools: [], files: [] },
      verified: { status: "available", items: [{ kind: "file", path: "/private/claimed.js", source: "runtime_receipt" }] },
    },
  }]);
  const imported = sessions.getWorkSession(session.id).messages.find(message => message.id.startsWith("legacy:"));
  assert.equal(imported.outcome, undefined);
  assert.equal(imported.runId, undefined);
});
