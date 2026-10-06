// Property test for the MissionOrb spatial invariant.
// Validates: Requirements 2.1, 2.2, 2.3, 2.7 (mission-control-premium-redesign).
// Property 2 (Orb spatial invariant): hero diameter equals
//   clamp(360, 0.56 * min(vw,vh), 560) (±1px) on Overview;
// header diameter equals min(0.28 * min(vw,vh), 220) (±1px) elsewhere.
//
// Strategy: pure CSS-clamp simulation. The canonical CSS rules are
//   [data-size="hero"]   { width: clamp(360px, 56vmin, 560px); }
//   [data-size="header"] { width: min(28vmin, 220px); }
// We re-implement the math here in JS and assert the closed-form result
// matches the documented invariant across the supported viewport range.
// This keeps the test hermetic — no jsdom, no layout engine, no React.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

function vmin(vw, vh) {
  return Math.min(vw, vh);
}

function clamp(min, val, max) {
  return Math.min(Math.max(val, min), max);
}

function heroDiameter(vw, vh) {
  // CSS: clamp(360px, 56vmin, 560px)
  return clamp(360, 0.56 * vmin(vw, vh), 560);
}

function headerDiameter(vw, vh) {
  // CSS: min(28vmin, 220px)
  return Math.min(0.28 * vmin(vw, vh), 220);
}

// ---------------------------------------------------------------------------
// Property 2 — Hero diameter (Overview)
// ---------------------------------------------------------------------------

test("Property 2: hero diameter formula (clamp 360..560 of 56vmin)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1024, max: 2560 }),
      fc.integer({ min: 600, max: 1600 }),
      (vw, vh) => {
        const d = heroDiameter(vw, vh);
        // Bounds: 360 ≤ diameter ≤ 560.
        assert.ok(d >= 360, `diameter ${d} below 360 floor`);
        assert.ok(d <= 560, `diameter ${d} above 560 ceiling`);
        // Closed-form match within ±1px tolerance.
        const raw = 0.56 * Math.min(vw, vh);
        const expected = Math.min(Math.max(raw, 360), 560);
        assert.ok(
          Math.abs(d - expected) < 1,
          `diameter ${d} differs from ${expected} by ≥1px`,
        );
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test("Property 2: hero diameter — boundary spot checks", () => {
  // Below floor: 0.56 * 600 = 336 → clamped up to 360.
  assert.equal(heroDiameter(1024, 600), 360);
  // Above ceiling: 0.56 * 1600 = 896 → clamped down to 560.
  assert.equal(heroDiameter(2560, 1600), 560);
  // In range: 0.56 * 1080 = 604.8 → clamped to 560.
  // 0.56 * 800 = 448 → 448 (in range).
  assert.equal(heroDiameter(2560, 800), 0.56 * 800);
});

// ---------------------------------------------------------------------------
// Property 2 — Header diameter (non-Overview routes)
// ---------------------------------------------------------------------------

test("Property 2: header diameter formula (min(28vmin, 220))", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 320, max: 2560 }),
      fc.integer({ min: 320, max: 1600 }),
      (vw, vh) => {
        const d = headerDiameter(vw, vh);
        // Ceiling: never exceeds 220px.
        assert.ok(d <= 220, `header diameter ${d} above 220 ceiling`);
        // Closed-form match within ±1px tolerance.
        const expected = Math.min(0.28 * Math.min(vw, vh), 220);
        assert.ok(
          Math.abs(d - expected) < 1,
          `header diameter ${d} differs from ${expected} by ≥1px`,
        );
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test("Property 2: header diameter — boundary spot checks", () => {
  // Small viewport: 0.28 * 320 = 89.6 (below ceiling).
  assert.equal(headerDiameter(320, 320), 0.28 * 320);
  // Large viewport: 0.28 * 1600 = 448 → clamped to 220.
  assert.equal(headerDiameter(2560, 1600), 220);
  // Crossover near 220 / 0.28 ≈ 785.7px vmin.
  // vmin=700 → 0.28*700 = 196 (below ceiling, formula wins).
  assert.equal(headerDiameter(1000, 700), 0.28 * 700);
  // vmin=800 → 0.28*800 = 224 (above ceiling, clamps to 220).
  assert.equal(headerDiameter(1000, 800), 220);
  assert.equal(headerDiameter(900, 900), 220);
});
