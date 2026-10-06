// Browser-safe status projection. Only fresh, explicit lifecycle signals may
// animate the agent as working; an old task or a running gateway is not work.
export const RUNTIME_STALE_MS = 20_000;
export const ACTIVITY_STALE_MS = 120_000;
const DONE = new Set(["complete", "completed", "done", "error", "failed", "cancelled"]);
const ACTIVE = new Set(["queued", "active", "running"]);
const LANES = new Set(["voice/action", "voice/data", "hermes/tool", "hermes/task"]);

export function eventTimestamp(event) {
  const value = event?.updatedAt || event?.ts;
  const timestamp = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function lifecycleKey(event) {
  const source = String(event?.source || "");
  // Uncorrelated tool events cannot prove that a tool is still running.
  if (source === "hermes/tool") return event.callId ? `${event.sessionId || ""}:tool:${event.callId}` : null;
  return `${source}:${event.sessionId || ""}:${String(event?.runId || event?.id || "").replace(/:(running|complete|failed)$/, "")}`;
}

export function selectCurrentActivity(activity, { now = Date.now(), sessionId } = {}) {
  const events = (Array.isArray(activity) ? activity : []).filter((event) =>
    event && LANES.has(event.source) && (!sessionId || event.source !== "voice/action" && event.source !== "voice/data" || event.sessionId === sessionId),
  );
  const finished = new Set(events.filter((event) => DONE.has(event.state)).map(lifecycleKey).filter(Boolean));
  return events.filter((event) => {
    const key = lifecycleKey(event);
    const timestamp = eventTimestamp(event);
    return key && !finished.has(key) && ACTIVE.has(event.state) && timestamp !== null && timestamp <= now + 5_000 && now - timestamp <= ACTIVITY_STALE_MS;
  }).sort((a, b) => eventTimestamp(b) - eventTimestamp(a))[0] || null;
}

function toolOrbState(toolName) {
  const name = String(toolName || "").toLowerCase();
  if (/search|browse|web|find/.test(name)) return "searching";
  if (/write|edit|patch|document|compose/.test(name)) return "composing";
  if (/connect|fetch|request|api/.test(name)) return "connecting";
  if (/image|render|design/.test(name)) return "shaping";
  if (/delegate|agent|parallel|team/.test(name)) return "weaving";
  if (/read|query|calculate|analyze|think/.test(name)) return "solving";
  return "working";
}

export function deriveOrbActivity({ voiceState = "idle", voiceCaption = "", activity = [], gateway = null, fetchedAt = null, now = Date.now(), sessionId, connectionError = false, runtimeReady = false } = {}) {
  const result = (state, label, source, updatedAt = null, isStale = false, orbState = "breathing") => ({ state, label, source, updatedAt, isStale, orbState });
  const voice = {
    listening: ["listening", "Listening", "listening"],
    capturing: ["listening", "Listening", "listening"],
    transcribing: ["thinking", "Understanding your voice", "solving"],
    thinking: ["thinking", "Thinking", "solving"],
    speaking: ["speaking", "Speaking", "composing"],
    error: ["error", "Voice needs attention", "breathing"],
  }[voiceState];
  if (voice) return result(voice[0], voiceCaption || voice[1], "voice", null, false, voice[2]);

  const fetched = eventTimestamp({ updatedAt: fetchedAt });
  const stale = connectionError || fetched === null || now - fetched > RUNTIME_STALE_MS || fetched > now + 5_000;
  if (!stale) {
    const current = selectCurrentActivity(activity, { now, sessionId });
    if (current) return result("working", current.title || "Working", current.source, current.updatedAt, false, current.state === "queued" ? "connecting" : toolOrbState(current.toolName));
    if (gateway?.online && !gateway.isStale && gateway.activeAgents > 0) {
      return result("working", gateway.activeAgents === 1 ? "Working on a task" : `Working on ${gateway.activeAgents} tasks`, "gateway", gateway.updatedAt, false, "solving");
    }
  }
  if (stale) return result("offline", fetched === null ? "Connecting to Hermes" : "Live status delayed", "connection", fetchedAt, true);
  if (runtimeReady) return result("idle", "Ready for a request", "runtime", fetchedAt);
  if (gateway?.isStale) return result("idle", "Gateway status unavailable", "gateway", gateway.updatedAt, true);
  if (gateway?.online === false) return result("offline", "Gateway offline", "gateway", gateway.updatedAt);
  return result("idle", gateway?.online ? "Ready when you are" : "Gateway status unavailable", "gateway", gateway?.updatedAt || null, !gateway);
}
