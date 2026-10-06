/** Presentation mapping only. Runtime freshness and tool classification live
 * in agent runtime state; this layer gives immediate voice interaction priority.
 */
export const THINKING_ORB_STATES = Object.freeze([
  "working", "searching", "solving", "listening", "connecting",
  "weaving", "composing", "breathing", "shaping",
]);

const VISUALS = {
  idle: { orbState: "breathing", label: "Ready", speed: 0.3 },
  starting: { orbState: "connecting", label: "Starting microphone", speed: 0.45 },
  listening: { orbState: "listening", label: "Listening", speed: 0.7 },
  capturing: { orbState: "listening", label: "Hearing you", speed: 1 },
  transcribing: { orbState: "solving", label: "Transcribing", speed: 0.65 },
  thinking: { orbState: "solving", label: "Thinking", speed: 0.65 },
  working: { orbState: "working", label: "Working", speed: 0.75 },
  speaking: { orbState: "composing", label: "Speaking", speed: 0.8 },
  error: { orbState: "breathing", label: "Needs attention", speed: 0, paused: true },
  offline: { orbState: "breathing", label: "Disconnected", speed: 0, paused: true },
};
const VOICE_STATES = new Set([
  "starting", "listening", "capturing", "transcribing", "thinking", "speaking", "error",
]);

function legacyState(status) {
  const value = typeof status === "string" ? status.toLowerCase().trim() : "";
  if (Object.hasOwn(VISUALS, value)) return value;
  if (/\bspeaking\b/.test(value)) return "speaking";
  if (/\bthinking\b|\bprocessing\b/.test(value)) return "thinking";
  if (/\blistening\b/.test(value)) return "listening";
  if (/\berror\b/.test(value)) return "error";
  return "idle";
}

export function resolveMissionOrb({ voiceState, contextVoiceState, activity, status } = {}) {
  // An explicitly supplied voice state retains the existing component API.
  const liveVoice = voiceState ?? contextVoiceState;
  if (VOICE_STATES.has(liveVoice)) {
    return { state: liveVoice, ...VISUALS[liveVoice], paused: liveVoice === "error", isStale: false };
  }

  const suppliedState = activity?.state ?? legacyState(status);
  let state = Object.hasOwn(VISUALS, suppliedState) ? suppliedState : "idle";
  const isStale = Boolean(activity?.isStale ?? activity?.stale);
  // Expired telemetry cannot keep presenting work as current activity.
  if (isStale && state !== "offline" && state !== "error") state = "idle";
  const visual = VISUALS[state];
  const orbState = !isStale && !visual.paused && THINKING_ORB_STATES.includes(activity?.orbState)
    ? activity.orbState
    : visual.orbState;
  return {
    state,
    ...visual,
    orbState,
    label: isStale ? "Status unavailable" : activity?.label || visual.label,
    paused: Boolean(visual.paused || isStale),
    isStale,
  };
}
