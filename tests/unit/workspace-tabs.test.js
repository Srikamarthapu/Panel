import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repository = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "panel-workspace-tabs-"));
const previous = {
  cwd: process.cwd(),
  data: process.env.PANEL_DATA_DIR,
  root: process.env.PANEL_APP_ROOT,
  transport: process.env.HERMES_VOICE_TRANSPORT,
};
process.chdir(fixture);
process.env.PANEL_DATA_DIR = path.join(fixture, "data");
process.env.PANEL_APP_ROOT = repository;

const tabs = await import("../../lib/workspace-tabs.js");
const actions = await import("../../lib/workspace-tab-actions.js");
const contract = await import("../../lib/workspace-tab-contract.js");
const launcher = await import("../../lib/assistant-launch.js");
const runs = await import("../../lib/assistant-runs.js");
const sessions = await import("../../lib/work-sessions.js");
const runtime = await import("../../lib/hermes-acp-runtime.js");

after(() => {
  process.chdir(previous.cwd);
  if (previous.data === undefined) delete process.env.PANEL_DATA_DIR; else process.env.PANEL_DATA_DIR = previous.data;
  if (previous.root === undefined) delete process.env.PANEL_APP_ROOT; else process.env.PANEL_APP_ROOT = previous.root;
  if (previous.transport === undefined) delete process.env.HERMES_VOICE_TRANSPORT; else process.env.HERMES_VOICE_TRANSPORT = previous.transport;
  fs.rmSync(fixture, { recursive: true, force: true });
});

function completeTurn(sessionId, id, text, response, extra = {}) {
  runs.createAssistantRun({ id, sessionId, text, textOnly: true, source: "workspace", ...extra });
  return runs.updateAssistantRun(id, { state: "complete", response, executionActive: false, executionFinishedAt: new Date().toISOString() });
}

function fakeSpawn() {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("workspace creation preserves authoritative planner metadata on its session", () => {
  const tab = tabs.createWorkspaceTab({ id: "metadata-tab", title: "Research board" });
  const planner = sessions.getWorkSession(tab.sessionId);
  const execution = sessions.getWorkSession(tab.executionSessionId);
  assert.equal(planner.workspaceTabId, tab.id);
  assert.equal(planner.workspaceRole, "planner");
  assert.equal(planner.workingDirectory, fs.realpathSync(tabs.workspaceTabPaths(tab.id).directory));
  assert.equal(execution.workspaceTabId, undefined);
  assert.equal(execution.workspaceRole, undefined);
});

test("planner sessions reject non-ACP and unattended task execution before creating a run", async () => {
  const tab = tabs.createWorkspaceTab({ id: "planner-policy", title: "Policy" });
  process.env.HERMES_VOICE_TRANSPORT = "direct";
  await assert.rejects(launcher.startAssistantRun({ id: "planner-direct", sessionId: tab.sessionId, text: "Plan this", source: "workspace" }), /persistent Hermes runtime/);
  assert.equal(runs.getAssistantRun("planner-direct"), null);
  process.env.HERMES_VOICE_TRANSPORT = "acp";
  await assert.rejects(launcher.startAssistantRun({ id: "planner-task", sessionId: tab.sessionId, text: "Plan this", source: "task" }), /persistent Hermes runtime/);
  assert.equal(runs.getAssistantRun("planner-task"), null);
});

test("prepare-plan requires two completed user turns and launches a tools-off review turn", async () => {
  process.env.HERMES_VOICE_TRANSPORT = "acp";
  const tab = tabs.createWorkspaceTab({ id: "prepare-plan", title: "Prepare" });
  completeTurn(tab.sessionId, "prepare-one", "I need a local notes tab.", "What should it help you finish?");
  const before = tabs.getWorkspaceTab(tab.id);
  await assert.rejects(actions.workspaceTabAction(tab.id, { action: "plan", requestId: "review-too-early" }), /at least two turns/);
  assert.equal(runs.getAssistantRun("review-too-early"), null);
  assert.deepEqual(tabs.getWorkspaceTab(tab.id), before);

  completeTurn(tab.sessionId, "prepare-two", "Help me review one project note without integrations.", "That is enough to prepare the plan.");
  await actions.workspaceTabAction(tab.id, { action: "plan", requestId: "review-ready" }, { spawnProcess: fakeSpawn });
  const payload = JSON.parse(fs.readFileSync(runs.requestFileForRun("review-ready"), "utf8"));
  assert.equal(payload.disableTools, true);
  assert.match(payload.workspaceInstructions, /exactly ONE fenced panel-plan JSON object/);
  assert.match(payload.workspaceInstructions, /review card is not approval to build/i);
  assert.match(payload.text, /^Prepare the plan for review/);
  assert.match(payload.text, /fenced panel-plan JSON object/);

  const fallback = tabs.createWorkspaceTab({ id: "prepare-json-fallback", title: "Fallback" });
  completeTurn(fallback.sessionId, "fallback-one", "I need local notes.", "What should the notes support?");
  completeTurn(fallback.sessionId, "fallback-two", "Review a project with no integrations.", "I understand the scope.");
  const plan = { title: "Project notes", outcome: "Review one project locally.", features: ["Notes field"], connections: ["None"], boundaries: ["No live data"], checks: ["Notes persist"] };
  completeTurn(fallback.sessionId, "fallback-review", "Prepare the plan with a panel-plan JSON object.", `Plan ready.\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, { workspaceMode: "review" });
  const fallbackDetails = tabs.workspaceTabDetails(fallback.id);
  assert.deepEqual(fallbackDetails.tab.suggestedPlan, plan);
  assert.equal(fallbackDetails.messages.some(message => message.role === "user" && /panel-plan JSON/.test(message.text)), false);
  assert.equal(fallbackDetails.messages.at(-1).text, "Plan ready.");
});

test("build requires the current plan digest and matching reserved run, then forces tools off", async () => {
  process.env.HERMES_VOICE_TRANSPORT = "acp";
  const tab = tabs.createWorkspaceTab({ id: "approved-build", title: "Draft" });
  completeTurn(tab.sessionId, "plan-question", "I need a focused tracker.", "Which details should it store?");
  const plan = { title: "Focus tracker", outcome: "Track a short daily focus list locally.", features: ["Add and complete focus items"], connections: [], boundaries: ["Local data only"], checks: ["Items persist after reload"] };
  completeTurn(tab.sessionId, "plan-final", "Store tasks locally and keep it simple.", `Ready.\n\n\`\`\`panel-plan\n${JSON.stringify(plan)}\n\`\`\``);
  const details = tabs.workspaceTabDetails(tab.id);
  assert.deepEqual(details.tab.suggestedPlan, plan);
  assert.match(details.tab.planDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(actions.workspaceTabAction(tab.id, { action: "build", requestId: "stale-plan", planDigest: "0".repeat(64) }), /review its latest plan/);
  assert.equal(runs.getAssistantRun("stale-plan"), null);

  tabs.updateWorkspaceTab(tab.id, { plan, phase: "building", buildRunId: "approved-run", buildPlanDigest: details.tab.planDigest, buildReservedAt: new Date().toISOString() });
  await assert.rejects(launcher.startAssistantRun({ id: "wrong-run", sessionId: tab.sessionId, text: "Build", source: "workspace", workspaceMode: "build", workspacePlanDigest: details.tab.planDigest }), /current tab plan/);
  await assert.rejects(launcher.startAssistantRun({ id: "approved-run", sessionId: tab.sessionId, text: "Build", source: "workspace", workspaceMode: "build", workspacePlanDigest: "0".repeat(64) }), /current tab plan/);

  await launcher.startAssistantRun({ id: "approved-run", sessionId: tab.sessionId, text: "Build", source: "workspace", workspaceMode: "build", workspacePlanDigest: details.tab.planDigest, disableTools: false }, { spawnProcess: fakeSpawn });
  const payload = JSON.parse(fs.readFileSync(runs.requestFileForRun("approved-run"), "utf8"));
  assert.equal(payload.disableTools, true);
  assert.match(payload.workspaceInstructions, /approved this plan/);
  assert.match(payload.workspaceInstructions, /Focus tracker/);
});

test("a fresh build reservation survives the missing-run launch gap and reconciles its exact completed run", () => {
  const tab = tabs.createWorkspaceTab({ id: "reservation-race", title: "Reserved" });
  const plan = { title: "Reserved", outcome: "Render a local list.", features: ["List items"], connections: [], boundaries: ["Offline"], checks: ["Renders one heading"] };
  tabs.updateWorkspaceTab(tab.id, { plan, phase: "building", buildRunId: "reserved-run", buildRunIds: ["reserved-run"], buildPlanDigest: "a".repeat(64), buildReservedAt: new Date().toISOString(), error: null });
  const duringGap = tabs.workspaceTabDetails(tab.id).tab;
  assert.equal(duringGap.phase, "building");
  assert.equal(duringGap.error, null);

  const spec = { title: "Reserved", description: "A local list.", blocks: [{ id: "items", type: "checklist", title: "Items", items: ["First item"] }] };
  completeTurn(tab.sessionId, "reserved-run", "Build the preview.", `\`\`\`panel-tab\n${JSON.stringify(spec)}\n\`\`\``);
  const completed = tabs.workspaceTabDetails(tab.id).tab;
  assert.equal(completed.phase, "preview");
  assert.match(completed.previewVersion, /^[a-f0-9-]{36}$/);
  assert.equal(completed.buildRunId, "reserved-run");
  assert.deepEqual(tabs.readWorkspaceTabArtifact(tab.id, { preview: true }).spec, spec);
  const published = tabs.publishWorkspaceTab(tab.id, completed.previewVersion);
  assert.equal(published.phase, "published");
  assert.equal(published.publishedVersion, completed.previewVersion);
  assert.throws(() => tabs.publishWorkspaceTab(tab.id, "00000000-0000-0000-0000-000000000000"), /preview changed/);
});

test("runtime identity separates planning-only agents from tool-capable agents", () => {
  const common = { sessionId: "same", workingDirectory: fixture, provider: "test", model: "model", reasoningEffort: "low", agentName: "Hermes", agentSoul: "same" };
  assert.notEqual(runtime.assistantRuntimeFingerprint({ ...common, disableTools: true }), runtime.assistantRuntimeFingerprint({ ...common, disableTools: false }));
  assert.equal(runtime.assistantRuntimeFingerprint({ ...common, disableTools: true }), runtime.assistantRuntimeFingerprint({ ...common, disableTools: true }));
});

test("declarative tab extraction rejects executable, unknown, fake-row, duplicate, and oversized structures", async () => {
  const spec = { title: "Project notes", description: "Keep a local project brief.", blocks: [
    { id: "intro", type: "text", title: "Context", text: "This stays local." },
    { id: "goal", type: "field", title: "Goal", label: "Current goal", kind: "text" },
    { id: "detail", type: "field", title: "Detail", label: "Level", kind: "select", options: ["Brief", "Full"] },
    { id: "notes", type: "notes", title: "Notes", label: "Working notes" },
    { id: "steps", type: "checklist", title: "Steps", items: ["Review scope"] },
    { id: "results", type: "table", title: "Results", columns: ["Item", "Status"] },
    { id: "review", type: "action", title: "Ask Hermes", label: "Review", prompt: "Review {{goal}} with {{notes}}" },
  ] };
  assert.deepEqual(contract.parseWorkspaceSpec(spec), spec);
  assert.deepEqual(contract.extractWorkspaceSpec(`\`\`\`panel-tab\n${JSON.stringify(spec)}\n\`\`\``), spec);
  assert.throws(() => contract.extractWorkspaceSpec(`\`\`\`html\n<html><script>alert(1)</script></html>\n\`\`\``), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, script: "alert(1)" }), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: [{ id: "table", type: "table", title: "Fake", columns: ["Value"], rows: [["invented"]] }] }), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: [spec.blocks[0], { ...spec.blocks[0] }] }), /valid Panel tab/);
  for (const id of ["__proto__", "constructor", "prototype"]) assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: [{ id, type: "text", title: "Reserved", text: "No" }] }), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: [{ id: "run", type: "action", title: "Run", label: "Run", prompt: "Use {{missing}}" }] }), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: [{ id: "run", type: "action", title: "Run", label: "Run", prompt: "Use {{not valid}}" }] }), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: [{ id: "run", type: "action", title: "Run", label: "Run", prompt: "Approve: safe\u202Etxt" }] }), /valid Panel tab/);
  assert.throws(() => contract.parseWorkspaceSpec({ ...spec, blocks: Array.from({ length: 21 }, (_, index) => ({ id: `b${index}`, type: "text", title: "Text", text: "Value" })) }), /valid Panel tab/);

  const tab = tabs.createWorkspaceTab({ id: "state-bounds", title: "State" });
  assert.equal(tabs.saveWorkspaceTabState(tab.id, { items: ["one"] }), true);
  assert.deepEqual(tabs.readWorkspaceTabState(tab.id), { items: ["one"] });
  assert.throws(() => tabs.saveWorkspaceTabState(tab.id, { value: "x".repeat(100_000) }), /100 KB/);
  assert.throws(() => tabs.saveWorkspaceTabState(tab.id, { value: "😀".repeat(25_000) }), /100 KB/);
  await assert.rejects(actions.workspaceTabAction(tab.id, { action: "run", requestId: "bidi-run", text: "Review safe\u202Etxt" }), /hidden direction controls/);
});
