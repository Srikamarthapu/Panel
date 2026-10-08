const BLOUB_STATE = Object.freeze({
  idle: "idle",
  starting: "swirl",
  // Voice attention uses the idle body with a dedicated expression. The
  // upstream wide/notify faces read as alarmed at hero size.
  listening: "idle",
  capturing: "idle",
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
  listening: "idle",
  capturing: "idle",
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

const eye = (w, h, tilt = 0) => Object.freeze({ w, h, tilt, open: 1 });
const expression = (id, { split, width, height, tilt = 0, roll = 0 }) => Object.freeze({
  id,
  gaze: Object.freeze({ yaw: 0, pitch: 0, roll }),
  split,
  eyes: Object.freeze([eye(width, height, tilt), eye(width, height, -tilt)]),
});

// Matches the upstream neutral face. Keeping a real neutral expression gives
// the engine two endpoints so returning from voice attention also morphs.
export const BLOUB_NEUTRAL_EXPRESSION = Object.freeze({
  id: "panel-neutral",
  gaze: Object.freeze({ yaw: 28.49, pitch: 28.62, roll: -13 }),
  split: 15.46,
  eyes: Object.freeze([eye(0.186, 0.412), eye(0.186, 0.412)]),
});

export const BLOUB_LISTENING_EXPRESSION = expression("panel-listening", {
  split: 16,
  width: 0.215,
  height: 0.44,
  tilt: 2,
  roll: -2,
});

export const BLOUB_CAPTURING_EXPRESSION = expression("panel-capturing", {
  split: 16.4,
  width: 0.235,
  height: 0.46,
  tilt: -2,
  roll: 2,
});

export function bloubExpressionFor(presenceState) {
  if (presenceState === "listening") return BLOUB_LISTENING_EXPRESSION;
  if (presenceState === "capturing") return BLOUB_CAPTURING_EXPRESSION;
  if (presenceState === "idle" || presenceState === "offline") return BLOUB_NEUTRAL_EXPRESSION;
  return null;
}

/**
 * Apply a presence transition without discarding the visible outgoing face.
 * Non-idle upstream states own their face, so retaining the prior expression
 * does not override them; it only supplies the correct origin for their morph.
 */
export function setBloubPresence(engine, presenceState, now, { preserveBody = false } = {}) {
  engine.setState(bloubStateFor(presenceState, { preserveBody }), now);
  const expression = bloubExpressionFor(presenceState);
  if (expression) engine.setExpression(expression, now);
}
