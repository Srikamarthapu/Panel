import path from "node:path";
import crypto from "node:crypto";
import { dataDirectory, readJson, writeJson, withFileLock } from "./work-store.js";

const statuses = new Set(["available", "auth_error", "not_found", "rate_limited", "timeout", "error"]);
const historyLimit = 256;
const historyAgeMs = 30 * 24 * 60 * 60 * 1000;
export const modelProbeKey = (provider, model) => JSON.stringify([provider, model]);
const evidenceFile = (directory) => path.join(directory, "model-probes.json");
const readEvidence = (file) => { try { return readJson(file, { records: [] }); } catch { return { records: [] }; } };

const credentialEnvironmentName = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|CREDENTIALS?|PASSWORD|AUTH|ACCOUNT|CLIENT_ID|CLIENT_SECRET|BASE_URL|ENDPOINT|PROJECT|TENANT|REGION)(?:_|$)/i;

export function modelCredentialRevision({ sources = [], environment = process.env, referencedEnvironmentNames = [] } = {}) {
  const hash = crypto.createHash("sha256");
  const referenced = new Set(referencedEnvironmentNames);
  // Only connection/account input belongs in this revision. Build stamps,
  // npm lifecycle values, local ports and process metadata change on restart.
  for (const [name, value] of Object.entries(environment).filter(([name]) => referenced.has(name) || credentialEnvironmentName.test(name)).sort(([a], [b]) => a.localeCompare(b))) hash.update(`${name}\0${value}\0`);
  for (const source of sources) { hash.update(source); hash.update("\0"); }
  return hash.digest("hex");
}

// Only application-generated metadata is saved or sent to the browser. Never
// store provider bodies, credential values, endpoint URLs or the test response.
export function sanitizeModelProbe(value) {
  if (!value || !statuses.has(value.status) || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  const provider = typeof value.provider === "string" ? value.provider : "";
  const model = typeof value.model === "string" ? value.model : "";
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(provider) || !model || model.length > 200 || /[\s\u0000-\u001f\u007f]/.test(model)) return null;
  return {
    provider, model, ok: value.status === "available" && value.ok === true,
    status: value.status, checkedAt: new Date(value.checkedAt).toISOString(),
    latencyMs: Number.isFinite(value.latencyMs) ? Math.max(0, Math.min(60_000, Math.round(value.latencyMs))) : 0,
    detail: probeDetail(value.status),
  };
}

export function readModelProbeEvidence({ directory = dataDirectory(), credentialRevision, credentialRevisions, now = Date.now() } = {}) {
  const saved = readEvidence(evidenceFile(directory));
  return Object.fromEntries((Array.isArray(saved.records) ? saved.records : []).flatMap(record => {
    const value = sanitizeModelProbe(record);
    const expectedRevision = value && (credentialRevisions ? credentialRevisions[value.provider] : credentialRevision);
    if (!value || !expectedRevision || record.credentialRevision !== expectedRevision || now - Date.parse(value.checkedAt) > historyAgeMs) return [];
    return [[modelProbeKey(value.provider, value.model), value]];
  }));
}

export function saveModelProbeEvidence(value, { directory = dataDirectory(), credentialRevision, now = Date.now() } = {}) {
  const result = sanitizeModelProbe(value);
  if (!result || !credentialRevision) throw new Error("Invalid model test evidence.");
  const file = evidenceFile(directory);
  withFileLock(file, () => {
    const saved = readEvidence(file);
    const records = (Array.isArray(saved.records) ? saved.records : []).filter(record =>
      sanitizeModelProbe(record) && now - Date.parse(record.checkedAt) <= historyAgeMs &&
      modelProbeKey(record.provider, record.model) !== modelProbeKey(result.provider, result.model));
    records.push({ ...result, credentialRevision });
    records.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
    writeJson(file, { version: 1, records: records.slice(0, historyLimit) });
  });
  return result;
}

function probeDetail(status) {
  return {
    available: "The provider returned a valid model response to a small test prompt.",
    auth_error: "The provider rejected access. Check this provider's credentials or account permissions.",
    not_found: "The provider could not find this exact model ID at its configured endpoint.",
    rate_limited: "The provider is rate limited. Try this test again later.",
    timeout: "The model did not return a response before the 12-second test limit. You can retry.",
    error: "The provider did not return a valid model response. Check the provider and try again.",
  }[status];
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing model response.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error("Model response exceeds test limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runConnectionProbe(connection, { fetchImpl = fetch, signal, timeoutMs = 12_000, now = Date.now } = {}) {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let status = "error";
  try {
    const anthropic = connection.protocol === "anthropic_messages";
    const responses = connection.protocol === "codex_responses";
    const tokenLimitParameter = !anthropic && connection.tokenLimitParameter === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
    const endpoint = `${String(connection.baseUrl).replace(/\/$/, "")}/${anthropic ? "messages" : responses ? "responses" : "chat/completions"}`;
    const headers = connection.extraHeaders || {};
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error", signal: combinedSignal,
      headers: anthropic
        ? { ...headers, "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
        : { ...headers, Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(responses ? { model: connection.model, input: "Reply with OK.", max_output_tokens: 64 } : { model: connection.model, messages: [{ role: "user", content: "Reply with OK." }], [tokenLimitParameter]: 64 }),
    });
    if (response.status === 401 || response.status === 403) status = "auth_error";
    else if (response.status === 404) status = "not_found";
    else if (response.status === 429) status = "rate_limited";
    else if (response.ok) {
      const body = await boundedJson(response);
      const message = body.choices?.[0]?.message;
      const content = anthropic ? body.content?.map(part => part.type === "text" ? part.text : "").join("") : responses ? body.output?.flatMap(item => item.content || []).map(part => part.type === "output_text" ? part.text : "").join("") : message?.content || message?.reasoning_content;
      // A small Responses token budget can be entirely spent on reasoning.
      // A structured generated reasoning item plus explicit reasoning usage is
      // inference evidence even when the provider has not reached answer text.
      const generatedReasoning = responses && body.object === "response" &&
        typeof body.id === "string" && body.id && ["completed", "incomplete"].includes(body.status) &&
        body.output?.some(item => item.type === "reasoning" && typeof item.id === "string" && item.id) &&
        Number.isFinite(body.usage?.output_tokens) && body.usage.output_tokens > 0 &&
        Number.isFinite(body.usage?.output_tokens_details?.reasoning_tokens) && body.usage.output_tokens_details.reasoning_tokens > 0;
      const generatedChatReasoning = !responses && !anthropic && body.object === "chat.completion" &&
        typeof body.id === "string" && body.id && message?.role === "assistant" &&
        ["stop", "length"].includes(body.choices?.[0]?.finish_reason) &&
        Number.isFinite(body.usage?.completion_tokens) && body.usage.completion_tokens > 0 &&
        Number.isFinite(body.usage?.completion_tokens_details?.reasoning_tokens) && body.usage.completion_tokens_details.reasoning_tokens > 0;
      if (typeof content === "string" && content.trim() || generatedReasoning || generatedChatReasoning) status = "available";
    }
    if (!response.ok) await response.body?.cancel().catch(() => {});
  } catch {
    status = combinedSignal.aborted ? "timeout" : "error";
  } finally { clearTimeout(timeout); }
  // Cancellation can race a fully buffered response, after fetch has settled.
  if (combinedSignal.aborted) status = "timeout";
  return sanitizeModelProbe({ provider: connection.provider, model: connection.model, ok: status === "available", status, checkedAt: new Date(now()).toISOString(), latencyMs: now() - startedAt });
}
