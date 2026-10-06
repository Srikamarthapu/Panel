/** The engine's idle look lets its own pose and ambient motion show through. */
export const BLOUB_IDLE_LOOK = Object.freeze({ yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 });

const MAX_SMOOTHING_DELTA = 0.064;
const LOOK_TIME_CONSTANT = 0.045;

/** A small bounded glance, expressed in the engine's gaze degrees. */
export function bloubPointerLook(point, bounds, viewport) {
  if (!point || !bounds?.width || !bounds?.height || !viewport?.width || !viewport?.height) return null;
  const x = point.x - (bounds.left + bounds.width / 2);
  const y = point.y - (bounds.top + bounds.height / 2);
  if (!Number.isFinite(x + y)) return null;
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  return {
    yaw: clamp(x / Math.max(viewport.width / 2, bounds.width)) * 28,
    // SVG Y grows down, but positive engine pitch rotates the projected eyes up.
    pitch: -clamp(y / Math.max(viewport.height / 2, bounds.height)) * 20,
    mix: 1,
    spin: 0,
    wander: 0,
  };
}

/**
 * Smooth a look target with a time-based low-pass filter. Clamping elapsed time
 * bounds catch-up after a dropped frame and keeps updates stable across refresh rates.
 */
export function bloubSmoothLook(current, target, deltaSeconds) {
  const from = current ?? BLOUB_IDLE_LOOK;
  const to = target ?? BLOUB_IDLE_LOOK;
  const delta = Number.isFinite(deltaSeconds)
    ? Math.max(0, Math.min(deltaSeconds, MAX_SMOOTHING_DELTA))
    : 0;
  const alpha = 1 - Math.exp(-delta / LOOK_TIME_CONSTANT);
  return {
    yaw: from.yaw + (to.yaw - from.yaw) * alpha,
    pitch: from.pitch + (to.pitch - from.pitch) * alpha,
    mix: from.mix + (to.mix - from.mix) * alpha,
    spin: from.spin + (to.spin - from.spin) * alpha,
    wander: from.wander + (to.wander - from.wander) * alpha,
  };
}
