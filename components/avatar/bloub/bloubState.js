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

export function bloubStateFor(presenceState) {
  return BLOUB_STATE[presenceState] || "idle";
}
