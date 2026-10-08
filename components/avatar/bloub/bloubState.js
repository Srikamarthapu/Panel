const BLOUB_STATE = Object.freeze({
  idle: "idle",
  starting: "swirl",
  listening: "wide",
  capturing: "notify",
  transcribing: "thinking",
  thinking: "orbit",
  working: "thinking",
  speaking: "play",
  error: "alert",
  // Keep Bloub recognizable while the runtime is unavailable. The status
  // copy carries the offline meaning; the sleeping silhouette reads as a dot.
  offline: "idle",
});

// Small companion Bloubs must keep a recognizable body. The upstream
// `thinking` pose intentionally turns the entire body into a three-dot glyph;
// at inline size that reads as a missing avatar beside an intact status bubble.
const PERSISTENT_BODY_STATE = Object.freeze({
  starting: "swirl",
  listening: "wide",
  capturing: "notify",
  transcribing: "wide",
  thinking: "wide",
  working: "wide",
  speaking: "play",
  error: "notify",
  offline: "idle",
  idle: "idle",
});

export function bloubStateFor(presenceState, { preserveBody = false } = {}) {
  if (preserveBody) return PERSISTENT_BODY_STATE[presenceState] || "idle";
  return BLOUB_STATE[presenceState] || "idle";
}
