import test from "node:test";
import assert from "node:assert/strict";
import { startAdaptivePolling } from "../../lib/adaptive-poll.js";

const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const timers = [];
  const listeners = new Map();
  const documentRef = {
    visibilityState: "visible",
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const setTimer = (callback, delay) => { const entry = { callback, delay, cancelled: false }; timers.push(entry); return entry; };
  const clearTimer = entry => { if (entry) entry.cancelled = true; };
  const nextTimer = () => timers.find(entry => !entry.cancelled && !entry.used);
  const fire = async entry => { entry.used = true; entry.callback(); await settle(); };
  return { timers, documentRef, listeners, setTimer, clearTimer, nextTimer, fire };
}

test("adaptive polling backs off after failures and resets after meaningful success", async () => {
  const clock = harness();
  const outcomes = [new Error("offline"), new Error("still offline"), "ok", "ok"];
  const errors = [];
  const polling = startAdaptivePolling({
    poll: async () => { const outcome = outcomes.shift(); if (outcome instanceof Error) throw outcome; },
    onError: error => errors.push(error.message),
    baseDelay: 100,
    maxDelay: 800,
    documentRef: clock.documentRef,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  assert.equal(clock.nextTimer().delay, 100);
  await clock.fire(clock.nextTimer());
  assert.equal(clock.nextTimer().delay, 200);
  await clock.fire(clock.nextTimer());
  assert.equal(clock.nextTimer().delay, 100);
  assert.deepEqual(errors, ["offline", "still offline"]);
  polling.stop();
});

test("adaptive polling suspends while hidden and resumes immediately when visible", async () => {
  const clock = harness();
  let reads = 0;
  const polling = startAdaptivePolling({
    poll: async () => { reads += 1; },
    baseDelay: 100,
    documentRef: clock.documentRef,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  assert.equal(reads, 1);
  clock.documentRef.visibilityState = "hidden";
  clock.listeners.get("visibilitychange")();
  assert.equal(clock.nextTimer(), undefined);
  clock.documentRef.visibilityState = "visible";
  clock.listeners.get("visibilitychange")();
  await settle();
  assert.equal(reads, 2);
  assert.equal(clock.nextTimer().delay, 100);
  polling.stop();
  assert.equal(clock.listeners.has("visibilitychange"), false);
});

test("stopping an in-flight poll prevents obsolete completion from scheduling again", async () => {
  const clock = harness();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const polling = startAdaptivePolling({
    poll: () => pending,
    baseDelay: 100,
    documentRef: clock.documentRef,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await settle();
  polling.stop();
  release();
  await settle();
  assert.equal(clock.nextTimer(), undefined);
  assert.equal(clock.listeners.has("visibilitychange"), false);
});
