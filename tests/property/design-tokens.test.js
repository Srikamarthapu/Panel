// Property tests for the Design_Tokens single source of truth.
// Validates: Requirements 9.2, 9.5, 9.8 (mission-control-premium-redesign).
// Properties: 26 (type scale invariant), 27 (elevation monotonicity),
// 29 (motion durations + easings mirrored to lib/design-tokens.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

import { MOTION } from "../../lib/design-tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "../../app/mission.css");
const css = readFileSync(cssPath, "utf8");

function num(value) {
  return Number.parseFloat(value);
}

test("Property 26: Type scale invariant", () => {
  const sizes = [14, 16, 18, 22, 28, 38, 56];
  const lines = [];
  for (let i = 1; i <= 7; i++) {
    const sizeMatch = css.match(new RegExp(`--type-${i}-size:\\s*([\\d.]+)px`));
    const lineMatch = css.match(new RegExp(`--type-${i}-line:\\s*([\\d.]+)`));
    assert.ok(sizeMatch, `--type-${i}-size missing`);
    assert.ok(lineMatch, `--type-${i}-line missing`);
    assert.equal(num(sizeMatch[1]), sizes[i - 1], `--type-${i}-size mismatch`);
    const line = num(lineMatch[1]);
    assert.ok(line >= 1.1 && line <= 1.6, `--type-${i}-line ${line} out of [1.1, 1.6]`);
    lines.push(line);
  }
  // Strictly monotonically decreasing line-heights as type size grows.
  for (let i = 1; i < lines.length; i++) {
    assert.ok(
      lines[i] < lines[i - 1],
      `line-heights not strictly monotonically decreasing at i=${i}: ${lines}`,
    );
  }
  // 14px (smallest) line-height in [1.4, 1.6].
  assert.ok(
    lines[0] >= 1.4 && lines[0] <= 1.6,
    `14px line ${lines[0]} not in [1.4, 1.6]`,
  );
  // 56px (largest) line-height in [1.1, 1.2].
  assert.ok(
    lines[6] >= 1.1 && lines[6] <= 1.2,
    `56px line ${lines[6]} not in [1.1, 1.2]`,
  );
});

test("Property 27: Elevation monotonicity invariant", () => {
  // Box-shadow shape: <x-offset> <y-offset>px <blur>px <color>.
  // Capture the blur radius (the second `px` value).
  const names = ["low", "medium", "high", "overlay"];
  const blurs = names.map((name) => {
    const m = css.match(
      new RegExp(`--elev-${name}:\\s*\\d+\\s+\\d+px\\s+(\\d+)px`),
    );
    assert.ok(m, `--elev-${name} blur radius missing`);
    return Number.parseInt(m[1], 10);
  });
  for (let i = 1; i < blurs.length; i++) {
    assert.ok(
      blurs[i] > blurs[i - 1],
      `elev blur not strictly increasing at i=${i}: ${blurs}`,
    );
  }
});

test("Property 29: Motion durations + easings invariant", () => {
  const expected = { fast: 120, base: 240, slow: 360, hero: 600 };
  for (const [k, v] of Object.entries(expected)) {
    const m = css.match(new RegExp(`--motion-${k}:\\s*${v}ms`));
    assert.ok(m, `--motion-${k} not found at ${v}ms`);
  }
  // Easings declared as cubic-bezier() functions.
  assert.match(css, /--easing-standard:\s*cubic-bezier\(/);
  assert.match(css, /--easing-soft:\s*cubic-bezier\(/);

  // JS mirror in lib/design-tokens.js mirrors CSS within float tolerance.
  assert.ok(Math.abs(MOTION.duration.fast - 0.12) < 1e-9);
  assert.ok(Math.abs(MOTION.duration.base - 0.24) < 1e-9);
  assert.ok(Math.abs(MOTION.duration.slow - 0.36) < 1e-9);
  assert.ok(Math.abs(MOTION.duration.hero - 0.6) < 1e-9);

  // Easings exposed as 4-tuples for motion/react.
  assert.ok(
    Array.isArray(MOTION.easing.standard) && MOTION.easing.standard.length === 4,
  );
  assert.ok(
    Array.isArray(MOTION.easing.soft) && MOTION.easing.soft.length === 4,
  );
});

test("design tokens parser is deterministic (smoke)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 7 }), (i) => {
      const a = css.match(new RegExp(`--type-${i}-size:\\s*([\\d.]+)px`))?.[1];
      const b = css.match(new RegExp(`--type-${i}-size:\\s*([\\d.]+)px`))?.[1];
      return a === b;
    }),
    { numRuns: 50 },
  );
});
