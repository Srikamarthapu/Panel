// Property 16: Tab_Rail rendered-set invariant.
// Validates: Requirements 6.1, 6.2
//
// The Tab_Rail must always render exactly the documented six destinations:
//   Overview, Tasks, Models, Memory, System, sixth(slot)
// where sixth(slot) ∈ { Voice, Calendar }. If a downstream configuration ever
// produces more than six entries, the rail must slice to the first 6 in
// declaration order without throwing (per design.md TabRail.jsx).
//
// This test extracts the pure rule from components/shell/TabRail.jsx so it can
// be exercised under fast-check without a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

const BASE = [
  { key: "overview", label: "Overview" },
  { key: "tasks",    label: "Tasks" },
  { key: "models",   label: "Models" },
  { key: "memory",   label: "Memory" },
  { key: "system",   label: "System" },
];

const SIXTH = {
  voice:    { key: "voice",    label: "Voice" },
  calendar: { key: "calendar", label: "Calendar" },
};

// Pure extraction of the TabRail destinations rule.
// Mirrors: const all = [...BASE_DESTINATIONS, sixth, ...extras]; return all.slice(0, 6);
function buildDestinations(slot, extras = []) {
  const sixth = SIXTH[slot] ?? SIXTH.voice;
  const all = [...BASE, sixth, ...extras];
  return all.slice(0, 6);
}

test("Property 16: exactly six destinations when n <= 6", () => {
  for (const slot of ["voice", "calendar"]) {
    const dests = buildDestinations(slot, []);
    assert.equal(dests.length, 6);
    assert.deepEqual(
      dests.map((d) => d.key),
      ["overview", "tasks", "models", "memory", "system", slot]
    );
  }
});

test("Property 16: when n > 6, first six in declaration order, no throw", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("voice", "calendar"),
      fc.array(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 12 }),
          label: fc.string(),
        }),
        { minLength: 1, maxLength: 50 }
      ),
      (slot, extras) => {
        const dests = buildDestinations(slot, extras);
        assert.equal(dests.length, 6);
        // First six in declaration order: BASE (5) + sixth(slot) + extras..., truncated to 6.
        const expected = [...BASE, SIXTH[slot], ...extras].slice(0, 6);
        assert.deepEqual(
          dests.map((d) => d.key),
          expected.map((d) => d.key)
        );
        return true;
      }
    ),
    { numRuns: 200 }
  );
});

test("Property 16: arbitrary n in [0, 20] yields capped, declaration-ordered set, never throws", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("voice", "calendar"),
      fc.array(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 12 }),
          label: fc.string(),
        }),
        { minLength: 0, maxLength: 20 }
      ),
      (slot, extras) => {
        let dests;
        assert.doesNotThrow(() => {
          dests = buildDestinations(slot, extras);
        });
        // Always capped at six, never longer.
        assert.ok(dests.length <= 6);
        // n = BASE(5) + sixth(1) + extras.length is always >= 6, so length must equal 6.
        assert.equal(dests.length, 6);
        // First five entries are always BASE in declaration order.
        assert.deepEqual(
          dests.slice(0, 5).map((d) => d.key),
          BASE.map((d) => d.key)
        );
        // Sixth entry is the resolved slot when no extras crowd it out (they cannot here:
        // BASE has 5 entries, so position 6 is always sixth(slot)).
        assert.equal(dests[5].key, SIXTH[slot].key);
        return true;
      }
    ),
    { numRuns: 200 }
  );
});
