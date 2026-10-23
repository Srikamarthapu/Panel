#!/usr/bin/env node
import fs from "node:fs";
import { appendAssistantText } from "../../lib/assistant-stream.js";
import { beginAssistantRun, finalizeAssistantRun, finishAssistantExecution, getAssistantRun, requestFileForRun, updateAssistantRun } from "../../lib/assistant-runs.js";
import { directProviderPublicMessage, resolveDirectProviderForAcceptedRequest, streamDirectCompletion } from "../../lib/direct-provider.js";
import { directMessages } from "../../lib/direct-runtime.js";
import { addVoiceActivity } from "../../lib/voiceActivity.js";

const id = process.argv[2];
const abort = new AbortController();
let payload, stopped = false, finished = false;
const activity = input => { try { addVoiceActivity({ sessionId: payload.sessionId, source: "voice/action", textOnly: payload.textOnly, ...input }); } catch {} };
function stop() { stopped = true; abort.abort(new Error("Request stopped.")); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

function finish(value) {
  if (finished || stopped || getAssistantRun(id)?.executionCancelRequestedAt) return;
  const run = finalizeAssistantRun(id, value);
  finished = true;
  if (!run || run.state === "cancelled") return;
  activity({
    id: `${id}:${run.state === "complete" ? "complete" : "failed"}`,
    kind: run.state === "complete" ? "tool" : "error",
    state: run.state,
    title: run.state === "complete" ? "Direct answer ready" : "Direct request needs attention",
    summary: run.response || run.error,
    target: "direct",
  });
}

async function main() {
  const run = beginAssistantRun(id);
  if (!run) return;
  const file = requestFileForRun(id);
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.unlinkSync(file);
    const connection = resolveDirectProviderForAcceptedRequest(payload.provider, payload.credentialFingerprint);
    if (stopped || getAssistantRun(id)?.executionCancelRequestedAt) return;
    activity({ id: `${id}:running`, kind: "tool", state: "active", title: "Waiting for the model…", summary: "", target: "direct" });
    let seq = 0;
    const result = await streamDirectCompletion({
      ...connection,
      model: payload.model,
      messages: directMessages(payload),
      signal: abort.signal,
      onDelta(delta) {
        if (stopped || getAssistantRun(id)?.executionCancelRequestedAt) return;
        appendAssistantText(id, { seq: ++seq, text: delta, messageId: `direct-${id}` });
        if (seq === 1 || seq % 12 === 0) updateAssistantRun(id, { statusLabel: "Composing a reply…" });
      },
    });
    if (stopped || getAssistantRun(id)?.executionCancelRequestedAt) return;
    finish({ state: "complete", response: result.response, error: "", usage: result.usage, selectedProvider: connection.provider.id, selectedModel: payload.model, selectedModelProvenance: "runtime" });
  } catch (error) {
    if (!stopped && !getAssistantRun(id)?.executionCancelRequestedAt) {
      finish({ state: "error", response: "", error: directProviderPublicMessage(error, "The direct provider request failed before an answer was confirmed. Check the connection and try again.") });
    }
  } finally {
    try { fs.unlinkSync(file); } catch {}
    if (!stopped) finishAssistantExecution(id);
  }
}

await main();
