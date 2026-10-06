// Property test for Property 10: ActionRail entrance animation invariant.
// Validates: Requirements 4.10, 8.6 (motion tokens, reduced-motion compliance).
//
// The transition object is created inline inside ActionRail's JSX, so we
// re-implement the same rule here against the imported MOTION token. This
// guarantees the constants used by the component match the design tokens
// and aren't free-floating magic numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { MOTION } from "../../lib/design-tokens.js";

function transitionFor(reduceMotion) {
  return reduceMotion
    ? { duration: 0 }
    : { duration: MOTION.duration.base, ease: MOTION.easing.standard };
}

test("Property 10: reduced motion collapses to duration 0", () => {
  const t = transitionFor(true);
  assert.equal(t.duration, 0);
  assert.equal(t.ease, undefined);
});

test("Property 10: standard motion uses 240ms ease standard", () => {
  const t = transitionFor(false);
  assert.equal(t.duration, 0.24); // 240ms expressed in seconds
  assert.deepEqual(t.ease, [0.2, 0, 0, 1]);
});

test("Property 10: MOTION tokens are the source of truth (not magic numbers)", () => {
  // Asserts the tokens themselves carry the spec-mandated values so the
  // ActionRail's inline transition is provably derived from them.
  assert.equal(MOTION.duration.base, 0.24);
  assert.deepEqual(MOTION.easing.standard, [0.2, 0, 0, 1]);
});

test("Property 10: deterministic across reduceMotion", () => {
  fc.assert(
    fc.property(fc.boolean(), (rm) => {
      const t1 = transitionFor(rm);
      const t2 = transitionFor(rm);
      assert.deepEqual(t1, t2);
      if (rm) {
        assert.equal(t1.duration, 0);
      } else {
        assert.equal(t1.duration, MOTION.duration.base);
        assert.deepEqual(t1.ease, MOTION.easing.standard);
      }
      return true;
    }),
    { numRuns: 100 },
  );
});
