const TERMINAL_STATES = new Set(["complete", "error", "cancelled", "interrupted"]);
const TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "tool"]);
const TOOL_STATES = new Set(["pending", "in_progress", "completed", "failed"]);
const VERIFIED_KINDS = new Set(["file", "diff", "artifact"]);
const VERIFIED_SOURCES = new Set(["runtime_receipt", "post_run_check"]);

function text(value, limit) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) : "";
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function localLocation(value) {
  if (!value || typeof value !== "object") return null;
  let pathname = text(value.path, 4096);
  const rawUri = text(value.uri, 8192);
  if (!pathname && rawUri.startsWith("file://")) {
    try { pathname = decodeURIComponent(new URL(rawUri).pathname); } catch { return null; }
  }
  if (!pathname || !pathname.startsWith("/") || pathname.split("/").includes("..")) return null;
  const line = Number.isInteger(value.line) && value.line > 0 && value.line <= 10_000_000 ? value.line : null;
  return { path: pathname, ...(line ? { line } : {}), provenance: "runtime" };
}

function locationsFrom(event) {
  const candidates = Array.isArray(event?.locations) ? event.locations : [];
  const unique = new Map();
  for (const candidate of candidates) {
    const location = localLocation(candidate);
    if (location) unique.set(`${location.path}:${location.line || ""}`, location);
    if (unique.size >= 12) break;
  }
  return [...unique.values()];
}

/** Keep only structured, non-content tool receipts. rawInput, rawOutput, titles,
 * commands, and model prose are deliberately outside this contract. */
export function mergeToolReceipt(receipts, event, at = new Date().toISOString()) {
  const list = Array.isArray(receipts) ? receipts.slice(-32) : [];
  const callId = text(event?.toolCallId ?? event?.tool_call_id ?? event?.callId, 160);
  if (!callId) return list;
  const index = list.findIndex(item => item.callId === callId);
  const previous = index >= 0 ? list[index] : {};
  const kind = TOOL_KINDS.has(event?.kind) ? event.kind : TOOL_KINDS.has(event?.name) ? event.name : previous.kind || "tool";
  const incomingStatus = event?.status || (event?.type === "tool_result" ? event?.is_error ? "failed" : "completed" : event?.type === "tool_use" ? "in_progress" : null);
  const previousTerminal = ["completed", "failed"].includes(previous.status);
  const status = previousTerminal && !["completed", "failed"].includes(incomingStatus)
    ? previous.status
    : TOOL_STATES.has(incomingStatus) ? incomingStatus : previous.status || "in_progress";
  const locations = locationsFrom(event);
  const receipt = {
    callId,
    kind,
    status,
    startedAt: previous.startedAt || timestamp(event?.startedAt) || timestamp(at),
    ...(["completed", "failed"].includes(status) ? { finishedAt: previous.finishedAt || timestamp(event?.finishedAt) || timestamp(at) } : {}),
    locations: locations.length ? locations : previous.locations || [],
  };
  if (index >= 0) list[index] = receipt;
  else list.push(receipt);
  return list.slice(-32);
}

function normalizeToolReceipts(value) {
  let receipts = [];
  for (const item of Array.isArray(value) ? value.slice(-32) : []) receipts = mergeToolReceipt(receipts, item, item?.finishedAt || item?.startedAt);
  return receipts;
}

function normalizeVerifiedItems(value) {
  const items = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || !VERIFIED_KINDS.has(item.kind) || !VERIFIED_SOURCES.has(item.source)) continue;
    const location = localLocation(item);
    if (!location) continue;
    items.push({ kind: item.kind, path: location.path, ...(location.line ? { line: location.line } : {}), source: item.source, label: text(item.label, 160) || location.path.split("/").at(-1) });
    if (items.length >= 24) break;
  }
  return items;
}

export function createRunOutcome(run) {
  if (!run || !TERMINAL_STATES.has(run.state)) return null;
  const executionActive = run.executionActive === true;
  const tools = normalizeToolReceipts(run.outcomeEvidence?.toolReceipts);
  const files = [];
  const seen = new Set();
  fileReceipts: for (const tool of tools) for (const location of tool.locations) {
    const key = `${location.path}:${location.line || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ ...location, kind: tool.kind });
    if (files.length >= 24) break fileReceipts;
  }
  const verifiedItems = normalizeVerifiedItems(run.outcomeEvidence?.verifiedItems);
  const verifiedKeys = new Set(verifiedItems.map(item => `${item.kind}:${item.path}:${item.line || ""}`));
  for (const tool of tools) {
    if (verifiedItems.length >= 24) break;
    if (tool.status !== "completed" || !["edit", "delete", "move"].includes(tool.kind)) continue;
    for (const location of tool.locations) {
      if (verifiedItems.length >= 24) break;
      const key = `file:${location.path}:${location.line || ""}`;
      if (verifiedKeys.has(key)) continue;
      verifiedKeys.add(key);
      verifiedItems.push({ kind: "file", path: location.path, ...(location.line ? { line: location.line } : {}), source: "runtime_receipt", label: `${tool.kind} completed` });
    }
  }
  const summary = text(run.state === "complete" ? run.response : run.error, 12_000);
  const hasCompletedReceipts = verifiedItems.some(item => item.source === "runtime_receipt");
  const hasPostRunChecks = verifiedItems.some(item => item.source === "post_run_check");
  const runtimeModel = text(run.selectedModel, 160);
  const runtimeProvider = text(run.selectedProvider, 120);
  const requestedModel = text(run.requestedModel, 160);
  const requestedProvider = text(run.requestedProvider, 120);
  const routeProvenance = run.selectedModelProvenance === "runtime" ? "runtime" : "requested";
  const runtimeReported = routeProvenance === "runtime" && runtimeModel
    ? { provider: runtimeProvider, model: runtimeModel, provenance: "runtime" }
    : null;
  const requestedRoute = requestedModel || requestedProvider ? { provider: requestedProvider, model: requestedModel } : null;
  const modelMismatch = runtimeReported
    ? Boolean(requestedModel && (runtimeModel !== requestedModel || Boolean(requestedProvider && runtimeProvider && requestedProvider !== runtimeProvider)))
    : null;
  return {
    version: 1,
    state: run.state,
    finishedAt: executionActive ? null : timestamp(run.executionFinishedAt || run.updatedAt),
    execution: { active: executionActive, stopping: executionActive && Boolean(run.executionStopping || run.executionCancelRequestedAt || run.executionStopRequestedAt || run.state === "cancelled") },
    summary: { text: summary, provenance: run.state === "complete" ? "agent" : "runtime" },
    observed: { tools, files },
    verified: {
      status: verifiedItems.length ? "available" : "unavailable",
      items: verifiedItems,
      note: verifiedItems.length
        ? hasCompletedReceipts && hasPostRunChecks
          ? "Panel retained completed action receipts and bounded post-run checks. Action receipts alone do not prove the current file contents."
          : hasPostRunChecks
            ? "Panel retained bounded post-run checks reported for this run."
            : "Panel retained explicit completed action receipts. They do not prove the current file contents."
        : files.length
          ? "Panel observed runtime file locations, but did not receive a verified diff or artifact receipt."
          : "Panel did not receive a verified diff, changed-file list, or artifact receipt for this run.",
    },
    runtime: runtimeModel || runtimeProvider
      ? { model: runtimeModel, provider: runtimeProvider, provenance: routeProvenance }
      : requestedModel || requestedProvider
        ? { model: requestedModel, provider: requestedProvider, provenance: "requested" }
        : null,
    model: { requested: requestedRoute, reported: runtimeReported, mismatch: modelMismatch },
  };
}

export function normalizeRunOutcome(value) {
  if (!value || value.version !== 1 || !TERMINAL_STATES.has(value.state)) return null;
  const reported = value.model?.reported;
  const requested = value.model?.requested;
  return createRunOutcome({
    state: value.state,
    response: value.state === "complete" ? value.summary?.text : "",
    error: value.state === "complete" ? "" : value.summary?.text,
    updatedAt: value.finishedAt,
    executionActive: value.execution?.active === true,
    executionStopping: value.execution?.stopping === true,
    selectedModel: reported?.model || value.runtime?.model,
    selectedProvider: reported?.provider || value.runtime?.provider,
    selectedModelProvenance: (reported?.model || value.runtime?.provenance === "runtime") ? "runtime" : "requested",
    requestedModel: requested?.model || (value.runtime?.provenance === "requested" ? value.runtime?.model : ""),
    requestedProvider: requested?.provider || (value.runtime?.provenance === "requested" ? value.runtime?.provider : ""),
    outcomeEvidence: {
      toolReceipts: value.observed?.tools,
      verifiedItems: value.verified?.items,
    },
  });
}

export function outcomeFromLegacyResult({ state = "complete", response = "", error = "", updatedAt = null } = {}) {
  const terminalState = TERMINAL_STATES.has(state) ? state : error ? "error" : "complete";
  return createRunOutcome({ state: terminalState, response, error, updatedAt, outcomeEvidence: {} });
}

export function compactRunOutcome(value) {
  const outcome = normalizeRunOutcome(value);
  if (!outcome) return null;
  return {
    ...outcome,
    summary: { ...outcome.summary, text: outcome.summary.text.slice(0, 2_000) },
    observed: { tools: outcome.observed.tools.slice(-12), files: outcome.observed.files.slice(0, 8) },
    verified: { ...outcome.verified, items: outcome.verified.items.slice(0, 8) },
  };
}
