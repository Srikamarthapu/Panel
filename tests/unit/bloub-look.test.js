import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOUB_CENTERED_LOOK,
  BLOUB_IDLE_LOOK,
  bloubLookForState,
  bloubPointerLook,
  bloubSmoothLook,
} from "../../components/avatar/bloub/bloubLook.js";
import { BotEngine, RAYON } from "../../components/avatar/bloub/vendor/bloub-engine.js";

const bounds = { left: 450, top: 250, width: 100, height: 100 };
const viewport = { width: 1000, height: 600 };
const pointerAt = (x, y) => bloubPointerLook({ x, y }, bounds, viewport);

function projectedEyeCenter(frame) {
  assert.ok(frame.eyes.length > 0, "engine should render visible eyes");
  const centers = frame.eyes.map((eye) => {
    const match = eye.matrix.match(/^matrix\(([^)]+)\)$/);
    assert.ok(match, `expected an SVG eye matrix, got ${eye.matrix}`);
    const values = match[1].split(",").map(Number);
    assert.equal(values.length, 6);
    return { x: values[4], y: values[5] };
  });
  return centers.reduce((sum, center) => ({ x: sum.x + center.x / centers.length, y: sum.y + center.y / centers.length }), { x: 0, y: 0 });
}

function sampleLook(look, time = 1 / 60) {
  const engine = new BotEngine(RAYON, "idle");
  engine.setLook(look, 0, time);
  return projectedEyeCenter(engine.sample(time));
}

function trackRepeatedPointerUpdates(fps) {
  const engine = new BotEngine(RAYON, "idle");
  const target = pointerAt(700, 420);
  const delta = 1 / fps;
  const frames = Math.round(fps * 0.3);
  let time = 0;
  let look = { ...BLOUB_IDLE_LOOK };
  const centers = [];

  for (let frame = 0; frame < frames; frame += 1) {
    // The same cursor target is read on every paint, as it is while the user
    // holds the pointer still over Bloub.
    look = bloubSmoothLook(look, target, delta);
    const nextTime = time + delta;
    engine.setLook(look, time, delta);
    centers.push(projectedEyeCenter(engine.sample(nextTime)));
    time = nextTime;
  }

  return { centers, look };
}

test("pointer gaze points toward the cursor in SVG screen coordinates", () => {
  const center = pointerAt(500, 300);
  const right = pointerAt(700, 300);
  const below = pointerAt(500, 420);
  const above = pointerAt(500, 180);
  const far = pointerAt(9000, -9000);

  assert.ok(right.yaw > 0);
  assert.ok(below.pitch < 0, "positive SVG Y needs negative engine pitch");
  assert.ok(above.pitch > 0);
  assert.deepEqual([far.yaw, far.pitch], [28, 20]);
  assert.equal(center.mix, 1);
  assert.equal(center.wander, 0);
  assert.equal(bloubPointerLook({ x: NaN, y: 3 }, bounds, viewport), null);
  assert.equal(bloubPointerLook({ x: 2, y: 3 }, { width: 0 }, viewport), null);
});

test("listening and capturing replace stale pointer gaze with a centered target", () => {
  assert.equal(bloubLookForState("listening"), BLOUB_CENTERED_LOOK);
  assert.equal(bloubLookForState("capturing"), BLOUB_CENTERED_LOOK);
  assert.equal(bloubLookForState("idle"), null);
  assert.deepEqual(BLOUB_CENTERED_LOOK, { yaw: 0, pitch: 0, mix: 1, spin: 0, wander: 0 });

  const engine = new BotEngine(RAYON, "idle");
  const pointer = pointerAt(700, 420);
  engine.setLook(pointer, 0, 0.01);
  const pointerCenter = projectedEyeCenter(engine.sample(0.01));
  engine.setLook(BLOUB_CENTERED_LOOK, 0.01, 0.2);
  const transitionCenter = projectedEyeCenter(engine.sample(0.11));
  const centered = projectedEyeCenter(engine.sample(0.21));
  const directCenter = sampleLook(BLOUB_CENTERED_LOOK, 0.2);
  assert.ok(Math.hypot(transitionCenter.x - directCenter.x, transitionCenter.y - directCenter.y)
    < Math.hypot(pointerCenter.x - directCenter.x, pointerCenter.y - directCenter.y));
  assert.ok(Math.abs(centered.x - directCenter.x) < 0.01);
  assert.ok(Math.abs(centered.y - directCenter.y) < 0.01);
});

test("active companions center their gaze while hero activity keeps its vendor look", () => {
  for (const state of ["transcribing", "thinking", "working", "error"]) {
    assert.equal(bloubLookForState(state), null, `${state} keeps the hero look`);
    assert.equal(bloubLookForState(state, { preserveBody: true }), BLOUB_CENTERED_LOOK);
  }
  assert.equal(bloubLookForState("idle", { preserveBody: true }), null, "companion idle cursor behavior is unchanged");
});

test("sampled SVG eye centers move right and down toward the pointer", () => {
  const center = sampleLook(pointerAt(500, 300));
  const right = sampleLook(pointerAt(700, 300));
  const below = sampleLook(pointerAt(500, 420));

  assert.ok(right.x > center.x + 2, `right gaze should move projected eyes right: ${right.x} vs ${center.x}`);
  assert.ok(below.y > center.y + 2, `down gaze should move projected eyes down: ${below.y} vs ${center.y}`);
});

test("repeated pointer updates converge smoothly at different frame rates", () => {
  const neutral = sampleLook(pointerAt(500, 300));
  const at60 = trackRepeatedPointerUpdates(60);
  const at120 = trackRepeatedPointerUpdates(120);
  const first = at60.centers[0];
  const middle = at60.centers[7];
  const final = at60.centers.at(-1);
  const final120 = at120.centers.at(-1);
  const target = sampleLook(pointerAt(700, 420));
  const distanceToTarget = (point) => Math.hypot(point.x - target.x, point.y - target.y);

  assert.ok(first.x > neutral.x, "first filtered frame responds horizontally");
  assert.ok(at60.centers[4].y > neutral.y, "vertical tracking responds within five 60 Hz frames");
  assert.ok(distanceToTarget(middle) < distanceToTarget(first), "repeated updates move projected eyes toward the cursor");
  assert.ok(distanceToTarget(final) < distanceToTarget(middle), "tracking continues instead of restarting its easing");
  assert.ok(Math.abs(final.x - final120.x) < 0.1, "same elapsed time should yield the same horizontal eye position");
  assert.ok(Math.abs(final.y - final120.y) < 0.1, "same elapsed time should yield the same vertical eye position");
  assert.ok(at60.look.wander < 0.02, "ambient wander is suppressed while following the pointer");
});

test("look smoothing stays bounded after frame stalls and idle look is stable", () => {
  const look = pointerAt(700, 420);
  const immediate = bloubSmoothLook(BLOUB_IDLE_LOOK, look, 0);
  const oneFrame = bloubSmoothLook(BLOUB_IDLE_LOOK, look, 1 / 60);
  const stalled = bloubSmoothLook(BLOUB_IDLE_LOOK, look, 1);
  const capped = bloubSmoothLook(BLOUB_IDLE_LOOK, look, 0.064);
  const remainingAfterCap = Math.exp(-0.064 / 0.045);
  const reset = bloubSmoothLook(look, null, 0.064);

  assert.deepEqual(immediate, BLOUB_IDLE_LOOK);
  assert.ok(oneFrame.yaw > 0 && oneFrame.yaw < look.yaw);
  assert.deepEqual(stalled, capped);
  assert.ok(Math.abs(reset.yaw - look.yaw * remainingAfterCap) < 1e-12);
  assert.ok(Math.abs(reset.pitch - look.pitch * remainingAfterCap) < 1e-12);
  assert.ok(Math.abs(reset.mix - remainingAfterCap) < 1e-12);
  assert.ok(Math.abs(reset.wander - (1 - remainingAfterCap)) < 1e-12);
});
