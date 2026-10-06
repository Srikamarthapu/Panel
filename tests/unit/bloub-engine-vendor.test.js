import assert from "node:assert/strict";
import test from "node:test";
import { BotEngine, RAYON } from "../../components/avatar/bloub/vendor/bloub-engine.js";

test("vendored Bloub engine samples deterministic SVG geometry", () => {
  const engine = new BotEngine(RAYON, "idle");
  const first = engine.sample(1.25);
  const replay = engine.sample(1.25);
  assert.deepEqual(replay, first);
  assert.match(first.bodyPath, /^M/);
  assert.equal(first.eyes.length, 2);
});

test("vendored Bloub engine supports the Hermes conversation poses", () => {
  const engine = new BotEngine(RAYON, "idle");
  for (const state of ["wide", "notify", "thinking", "orbit", "play", "alert", "sleep"]) {
    engine.setState(state, 1);
    const frame = engine.sample(2);
    assert.equal(typeof frame.bodyPath, "string");
    assert.ok(frame.bodyPath.length > 20);
  }
});
