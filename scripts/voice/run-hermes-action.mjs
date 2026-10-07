#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addVoiceActivity } from "../../lib/voiceActivity.js";
import { beginAssistantRun, finishAssistantExecution, getAssistantRun, getConversationSession, recordJevDecision, requestFileForRun, saveConversationSession, updateAssistantRun } from "../../lib/assistant-runs.js";
import { friendlyRunError, readHermesResult, readHermesTurnResult } from "../../lib/hermes-run-protocol.js";
import { labelForToolCall } from "../../lib/hermesToolLabels.js";
import { routeControlModel } from "./jev-control-route.mjs";
import { recordSessionRun, validateWorkingDirectory } from "../../lib/work-sessions.js";
import { dataDirectory } from "../../lib/work-store.js";
import { buildControlSystemInstructions, turnInstructionsForTextOnly } from "../../lib/voiceTurnInstructions.js";

const actionId = process.argv[2];
const childGate = fileURLToPath(new URL("./run-hermes-child.mjs", import.meta.url));
const TURN_REPORT_ENV = "HERMES_QUIET_TURN_REPORT_FILE";
const TURN_REPORT_MAX_BYTES = 2_000_000;
const TURN_REPORT_GRACE_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 12 * 60_000;
const configuredTimeoutMs = Number(process.env.HERMES_VOICE_RUN_TIMEOUT_MS);
const RUN_TIMEOUT_MS = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
  ? Math.min(DEFAULT_RUN_TIMEOUT_MS, Math.max(250, configuredTimeoutMs))
  : DEFAULT_RUN_TIMEOUT_MS;

function resultSignature(result) {
  return JSON.stringify([result?.state || "", result?.response || "", result?.error || ""]);
}

function readQuietTurnReport(file, expectedPid) {
  if (!Number.isInteger(expectedPid) || expectedPid < 2) return null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > TURN_REPORT_MAX_BYTES) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (record.pid !== expectedPid || !Number.isInteger(record.exit_code)) return null;
    if (typeof record.error !== "string" || typeof record.reply !== "string") return null;
    const result = readHermesTurnResult({
      type: "turn_result",
      exit_code: record.exit_code,
      error: record.error,
      text: record.reply,
    });
    return result ? { record, result } : null;
  } catch {
    // The host writes atomically. A missing or unreadable report leaves JSONL
    // as the authoritative protocol and must never break the run.
    return null;
  }
}

let payload;
let child;
let stopped = false;
let finalized = false;
let executionOwned = false;
function activity(input) {
  try { addVoiceActivity({ sessionId: payload.sessionId, source: "voice/action", textOnly: payload.textOnly, ...input }); } catch {}
}
function finish(result) {
  if (finalized) return;
  finalized = true;
  const run = updateAssistantRun(actionId, result);
  if (!run || run.state === "cancelled") return;
  activity({ id: `${actionId}:${run.state === "complete" ? "complete" : "failed"}`, kind: run.state === "complete" ? "tool" : "error", state: run.state, title: run.state === "complete" ? "Hermes answered" : "Request needs attention", summary: run.response || run.error, target: "hermes" });
}
function signalChildGroup(signal) {
  try {
    if (child?.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child?.kill(signal);
  } catch {
    try { child?.kill(signal); } catch {}
  }
}
function stop(signal = "SIGTERM") { stopped = true; signalChildGroup(signal); }
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop("SIGINT"));

async function main() {
  const run = beginAssistantRun(actionId);
  if (!run) return;
  executionOwned = true;
  const requestFile = requestFileForRun(actionId);
  const turnReportFile = `${requestFile}.turn.json`;
  try { fs.unlinkSync(turnReportFile); } catch {}
  payload = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  fs.unlinkSync(requestFile);
  const workingDirectory = validateWorkingDirectory(payload.workingDirectory) || process.cwd();
  activity({ id: `${actionId}:running`, kind: "tool", state: "active", title: payload.statusLabel || "Thinking through your request…", summary: "", target: "hermes" });
  const session = getConversationSession(payload.sessionId);
  let provider = payload.provider || "";
  let model = payload.model || "";
  const routed = await routeControlModel({
    text: payload.text,
    provider,
    model,
    sessionId: payload.sessionId,
    turnId: actionId,
    onDecision: (decision) => recordJevDecision(actionId, decision),
  });
  if (routed?.selected === true) {
    provider = routed.provider;
    model = routed.model;
  }
  if (stopped || getAssistantRun(actionId)?.state === "cancelled") return;
  const queryFile = `${requestFile}.txt`;
  fs.writeFileSync(queryFile, payload.text, { mode: 0o600 });
  const args = ["chat", "--max-turns", "30", "--format", "stream-json", "--query-file", queryFile];
  if (session.hermesSessionId) args.push("--resume", session.hermesSessionId);
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  const home = os.homedir();
  const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
  const hermesRepo = process.env.HERMES_REPO || path.join(hermesHome, "hermes-agent");
  const hermesBin = process.platform === "win32"
    ? path.join(hermesRepo, "venv", "Scripts")
    : path.join(hermesRepo, "venv", "bin");
  const instruction = [
    buildControlSystemInstructions({ agentName: payload.agentName, agentSoul: payload.agentSoul }),
    turnInstructionsForTextOnly(payload.textOnly),
    "Only your final answer is shown in conversation. Tool progress is displayed separately. Never include internal tool markup, token usage, or protocol in your answer. Ask a concise question when genuinely missing information; otherwise finish the authorized work.",
    !session.hermesSessionId && payload.history?.length ? `Earlier conversation imported from this dashboard (context only):\n${JSON.stringify(payload.history).slice(-12000)}` : "",
  ].filter(Boolean).join("\n\n");
  const env = { ...process.env, PANEL_DATA_DIR: dataDirectory(), HERMES_HOME: hermesHome, HERMES_REPO: hermesRepo, PATH: [path.join(home, ".local", "bin"), hermesBin, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].filter(Boolean).join(path.delimiter), HERMES_EPHEMERAL_SYSTEM_PROMPT: instruction, HERMES_AGENT_MAX_TURNS: "30", HERMES_JEV_CONTROL: "1", [TURN_REPORT_ENV]: turnReportFile };
  if (payload.reasoningEffort) env.HERMES_REASONING_EFFORT = payload.reasoningEffort;
  let terminalResult = null;
  let earlyReceipt = null;
  let earlyReceiptSignature = "";
  let earlyReceiptAt = 0;
  let initialResultSignature = null;
  let publishedFollowupSignature = "";
  let pendingFollowup = null;
  let followupTimer = null;
  let followupSequence = 0;
  let lineBuffer = "";
  let stderr = "";
  let errorLineBuffer = "";
  let timedOut = false;
  let lastProgressWrite = 0;

  function publishFollowup(result) {
    if (stopped || getAssistantRun(actionId)?.executionCancelRequestedAt) return;
    const signature = resultSignature(result);
    if (!initialResultSignature || signature === initialResultSignature || signature === publishedFollowupSignature) return;
    publishedFollowupSignature = signature;
    followupSequence += 1;
    const complete = result.state === "complete";
    const now = new Date().toISOString();
    recordSessionRun({ id: `${actionId}:followup:${followupSequence}`, sessionId: payload.sessionId, ...result, createdAt: now, updatedAt: now });
    activity({
      id: `${actionId}:followup:${followupSequence}:${complete ? "complete" : "failed"}`,
      kind: complete ? "tool" : "error",
      state: complete ? "complete" : "error",
      title: complete ? "Hermes added a follow-up" : "A follow-up needs attention",
      summary: result.response || result.error,
      target: "hermes",
    });
  }

  function flushFollowup() {
    if (followupTimer) clearTimeout(followupTimer);
    followupTimer = null;
    if (pendingFollowup) publishFollowup(pendingFollowup);
    pendingFollowup = null;
  }

  function observeReceipt(result) {
    const signature = resultSignature(result);
    if (signature === earlyReceiptSignature) return;
    earlyReceipt = result;
    earlyReceiptSignature = signature;
    earlyReceiptAt = Date.now();
    if (finalized && signature !== initialResultSignature) {
      pendingFollowup = result;
      if (followupTimer) clearTimeout(followupTimer);
      followupTimer = setTimeout(flushFollowup, TURN_REPORT_GRACE_MS);
    }
  }

  function observeNativeReceipt() {
    if (stopped && !timedOut) return;
    if (!child?.pid) return;
    const report = readQuietTurnReport(turnReportFile, getAssistantRun(actionId)?.hermesCliPid);
    if (report) observeReceipt(report.result);
  }

  function finalizeEarlyReceipt() {
    if (finalized || stopped || !earlyReceipt) return;
    initialResultSignature = earlyReceiptSignature;
    finish(earlyReceipt);
  }

  function acceptFinalResult(result) {
    if (!result) return;
    terminalResult = result;
    const signature = resultSignature(result);
    if (!finalized) {
      initialResultSignature = signature;
      finish(result);
      return;
    }
    if (followupTimer) clearTimeout(followupTimer);
    followupTimer = null;
    pendingFollowup = null;
    publishFollowup(result);
  }

  function checkTurnReport() {
    observeNativeReceipt();
    if (!finalized && earlyReceipt && Date.now() - earlyReceiptAt >= TURN_REPORT_GRACE_MS) finalizeEarlyReceipt();
  }
  try {
    await new Promise((resolve) => {
      const childSpec = `${requestFile}.child.json`;
      fs.writeFileSync(childSpec, JSON.stringify({ command: process.env.HERMES_CLI_PATH || "hermes", args }), { mode: 0o600 });
      child = spawn(process.execPath, [childGate, actionId], { cwd: workingDirectory, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        checkTurnReport();
        if (!finalized && earlyReceipt) finalizeEarlyReceipt();
        if (!finalized) finish({ state: "error", response: "", error: "Hermes took too long and was stopped. Check whether any action completed before retrying." });
        stop();
      }, RUN_TIMEOUT_MS);
      let forceStop;
      const monitor = setInterval(() => {
        checkTurnReport();
        if (!stopped) return;
        if (!forceStop) forceStop = setTimeout(() => signalChildGroup("SIGKILL"), 4_000);
      }, 250);
      function consume(line) {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.session_id) saveConversationSession(payload.sessionId, event.session_id);
        if (event.type === "turn_result") {
          const result = readHermesTurnResult(event);
          if (result) observeReceipt(result);
          return;
        }
        if (event.type === "result") { acceptFinalResult(readHermesResult(event)); return; }
        if (!["tool_use", "tool_result"].includes(event.type)) {
          if (event.type === "text" && Date.now() - lastProgressWrite > 2_000) {
            lastProgressWrite = Date.now();
            updateAssistantRun(actionId, { statusLabel: "Composing a reply…" });
          }
          return;
        }
        const start = event.type === "tool_use";
        const label = labelForToolCall(event.name, event.input);
        const title = start ? label.title : event.is_error ? "A tool needs attention" : "Tool finished";
        updateAssistantRun(actionId, { statusLabel: start ? title : "Thinking through the result…" });
        // Tool arguments, results and private reasoning never enter the UI feed.
        activity({ kind: "tool", state: start ? "active" : event.is_error ? "error" : "done", source: "hermes/tool", title, summary: "", toolName: event.name, callId: event.tool_call_id || `${actionId}:${event.name}`, target: "hermes", ts: new Date(event.timestamp || Date.now()).toISOString() });
      }
      child.stdout.on("data", (chunk) => {
        lineBuffer += chunk.toString();
        if (lineBuffer.length > 2_000_000) { terminalResult = { state: "error", error: "Hermes returned an oversized response.", response: "" }; finish(terminalResult); stop(); return; }
        let index;
        while ((index = lineBuffer.indexOf("\n")) >= 0) { const line = lineBuffer.slice(0, index); lineBuffer = lineBuffer.slice(index + 1); consume(line); }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16000);
        errorLineBuffer = (errorLineBuffer + chunk.toString()).slice(-32000);
        let index;
        while ((index = errorLineBuffer.indexOf("\n")) >= 0) {
          const line = errorLineBuffer.slice(0, index); errorLineBuffer = errorLineBuffer.slice(index + 1);
          if (!line.startsWith("HERMES_JEV_EVENT ")) continue;
          try {
            const decision = JSON.parse(line.slice("HERMES_JEV_EVENT ".length));
            // A bypass event means Jev did not evaluate this step (for example a
            // provider retry or cooldown). It is diagnostic evidence, not UI work.
            if (decision.evaluated !== true) continue;
            recordJevDecision(actionId, decision);
            const contextDecision = decision.mode === "context" || decision.mode === "context-fallback";
            const title = decision.mode === "context" ? "Jev kept useful tool context" : decision.mode === "context-fallback" ? "Hermes kept the original context" : decision.mode === "direct" ? "Jev selected a ready action" : decision.mode === "forced" ? "Jev selected the next tool" : decision.mode === "finish" ? "Jev finished tool routing" : decision.progress && decision.progress !== "continue" ? "Jev detected a repeated approach" : "Jev deferred to Hermes";
            const summary = ({ uncertain_selection: "Jev evaluated the step but did not return a selection safe enough to override Hermes.", below_confidence: "Jev's selection was below the configured confidence threshold.", diffuse_selection: "Jev's probability was spread too widely to override Hermes.", invalid_choice_schema: "TypeSafe returned an unexpected Choice shape.", unknown_choice: "TypeSafe returned an option outside the advertised tool list.", missing_confidence: "TypeSafe did not return a valid confidence value.", incomplete_probabilities: "TypeSafe did not return probabilities for every advertised option.", invalid_probabilities: "TypeSafe returned invalid probability values.", inconsistent_selection: "TypeSafe's selected option did not match its probability distribution.", needs_hermes_reasoning: "Jev evaluated the step and left the next decision to Hermes.", compose_final_answer: "Jev evaluated the step and found the tool work complete.", hermes_fills_arguments: "Jev chose the tool; Hermes prepared its inputs.", grounded_read_arguments: "Jev chose a ready read-only action.", progress_checked: "Jev reviewed progress and kept Hermes in control.", reconsider_failed_strategy: "Jev detected a repeated approach and asked Hermes to reconsider.", provider_thinking_requires_auto: "Provider thinking mode requires automatic tool routing, so Jev evaluated the step and deferred to Hermes.", provider_finish_keeps_tools_available: "Jev suggested replying, while Hermes kept validated tools available in case another step was still needed." })[decision.reason] || "Jev evaluated this step.";
            const callId = `${actionId}:jev:${contextDecision ? "context:" : ""}${decision.iteration || 0}`;
            activity({ id: callId, kind: "tool", state: "done", source: "hermes/jev", title, summary, target: "jev", callId, toolName: typeof decision.tool === "string" ? decision.tool.slice(0, 120) : "" });
            if (!contextDecision) updateAssistantRun(actionId, { statusLabel: decision.mode === "direct" ? "Running the selected action…" : decision.mode === "forced" ? "Preparing the selected tool…" : decision.mode === "finish" ? "Composing a reply…" : "Thinking through your request…" });
          } catch { /* diagnostics never affect a running request */ }
        }
      });
      let ended = false;
      const end = (code, error) => {
        if (ended) return; ended = true;
        clearTimeout(timeout); clearInterval(monitor); clearTimeout(forceStop);
        if (lineBuffer.trim()) consume(lineBuffer);
        if (!stopped || timedOut) observeNativeReceipt();
        if (timedOut) finish({ state: "error", response: "", error: "Hermes took too long and was stopped. Check whether any action completed before retrying." });
        else if (!stopped || terminalResult?.state === "error") {
          if (!finalized) {
            if (terminalResult && code === 0) acceptFinalResult(terminalResult);
            else if (earlyReceipt) finalizeEarlyReceipt();
            else finish({ state: "error", response: "", error: terminalResult?.error || friendlyRunError(error?.message || stderr) });
          } else if (terminalResult) acceptFinalResult(terminalResult);
        }
        flushFollowup();
        resolve();
      };
      child.on("error", (err) => end(1, err));
      child.on("close", (code) => end(code));
    });
  } finally { try { fs.unlinkSync(queryFile); } catch {} try { fs.unlinkSync(turnReportFile); } catch {} try { fs.unlinkSync(`${requestFile}.child.json`); } catch {} }
}
main().catch(() => {
  if (payload) finish({ state: "error", response: "", error: "The local Hermes runtime could not start. Check Hermes setup and retry." });
  else updateAssistantRun(actionId, { state: "error", error: "The local Hermes runtime could not start." });
  process.exitCode = 1;
}).finally(() => { if (executionOwned) finishAssistantExecution(actionId); });
