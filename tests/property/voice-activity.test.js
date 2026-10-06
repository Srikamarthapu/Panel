// Property test for Voice activity emission sanitization + dedup window.
// Validates: Requirements 5.10 (mission-control-premium-redesign).
// Property 15: Activity emission dedup + sanitization invariant.
//
// Mirrors the `sanitize()` helper and dedup window inside
// `components/voice/VoiceProvider.jsx` (no DOM / fetch / real time required).
// Uses simulated monotonic time instead of `Date.now()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

// Constants mirror VoiceProvider.jsx exactly.
const TEXT_LIMIT = 500;
const ACTIVITY_DEDUP_MS = 1000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const AUTH_HEADER = /Authorization:\s*\S+/gi;
const BLOB_MARKER = /\[Blob:[^\]]+\]/gi;

function sanitize(s) {
  let out = String(s == null ? "" : s);
  out = out.replace(CONTROL_CHARS, "");
  out = out.replace(AUTH_HEADER, "[redacted]");
  out = out.replace(BLOB_MARKER, "[redacted]");
  if (out.length > TEXT_LIMIT) out = out.slice(0, TEXT_LIMIT);
  return out;
}

// Re-implements the dedup window in VoiceProvider.emitActivity. `now` is
// supplied by the caller (simulated time) instead of Date.now().
class Emitter {
  constructor() {
    this.recent = new Map();
    this.emitted = [];
  }
  emit(rawSummary, now) {
    const summary = sanitize(rawSummary);
    if (!summary) return false;
    const last = this.recent.get(summary);
    if (last !== undefined && now - last <= ACTIVITY_DEDUP_MS) return false;
    this.recent.set(summary, now);
    this.emitted.push({ summary, now });
    return true;
  }
}

test("Property 15: sanitize strips control chars, auth headers, blob markers, and caps length", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 0, maxLength: 2000 }), (s) => {
      const out = sanitize(s);
      assert.ok(
        out.length <= TEXT_LIMIT,
        `sanitized length ${out.length} exceeds ${TEXT_LIMIT}`,
      );
      assert.ok(
        !/[\u0000-\u001f\u007f]/.test(out),
        `control chars remain: ${JSON.stringify(out)}`,
      );
      assert.ok(
        !/Authorization:\s*\S+/i.test(out),
        `auth header remains: ${JSON.stringify(out)}`,
      );
      assert.ok(
        !/\[Blob:[^\]]+\]/i.test(out),
        `blob marker remains: ${JSON.stringify(out)}`,
      );
      return true;
    }),
    { numRuns: 200 },
  );
});

test("Property 15: sanitize handles explicit auth, blob, and control-char samples", () => {
  const cases = [
    "Authorization: Bearer abcdef123456",
    "before [Blob:audio/webm; size=2048] after",
    "control \x00\x01\x02\x07\x1f\x7f chars",
    "x".repeat(1200),
    null,
    undefined,
  ];
  for (const c of cases) {
    const out = sanitize(c);
    assert.ok(out.length <= TEXT_LIMIT);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(out));
    assert.ok(!/Authorization:\s*\S+/i.test(out));
    assert.ok(!/\[Blob:[^\]]+\]/i.test(out));
  }
  // The 1200-char filler case must be exactly truncated to 500.
  assert.equal(sanitize("x".repeat(1200)).length, TEXT_LIMIT);
  // null / undefined must produce an empty string, not "null"/"undefined".
  assert.equal(sanitize(null), "");
  assert.equal(sanitize(undefined), "");
  // Auth and blob redactions are deterministic.
  assert.match(sanitize("Authorization: Bearer secret"), /\[redacted\]/);
  assert.match(sanitize("[Blob:foo]"), /\[redacted\]/);
});

test("Property 15: emitted summaries always equal sanitize(input)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 600 }),
          fc.integer({ min: 0, max: 60_000 }),
        ),
        { minLength: 0, maxLength: 50 },
      ),
      (events) => {
        const e = new Emitter();
        // Simulate monotonic time by sorting on timestamp before emitting.
        const sorted = events.slice().sort((a, b) => a[1] - b[1]);
        for (const [raw, t] of sorted) {
          const before = e.emitted.length;
          e.emit(raw, t);
          if (e.emitted.length > before) {
            const last = e.emitted[e.emitted.length - 1];
            // Every emitted summary equals sanitize(raw).
            assert.equal(last.summary, sanitize(raw));
            // And satisfies all sanitize invariants.
            assert.ok(last.summary.length <= TEXT_LIMIT);
            assert.ok(last.summary.length > 0);
            assert.ok(!/[\u0000-\u001f\u007f]/.test(last.summary));
            assert.ok(!/Authorization:\s*\S+/i.test(last.summary));
            assert.ok(!/\[Blob:[^\]]+\]/i.test(last.summary));
          }
        }
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test("Property 15: dedup suppresses duplicates within 1000ms (consecutive emissions of same summary always > 1000ms apart)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          // Use ASCII letters + digits so sanitize is the identity and we can
          // exercise the dedup logic directly across many distinct summaries.
          fc.stringMatching(/^[a-zA-Z0-9 ]{1,40}$/),
          fc.integer({ min: 0, max: 30_000 }),
        ),
        { minLength: 2, maxLength: 50 },
      ),
      (events) => {
        const e = new Emitter();
        const sorted = events.slice().sort((a, b) => a[1] - b[1]);
        for (const [s, t] of sorted) e.emit(s, t);
        // For every pair of emitted items with the same summary, the gap
        // between their emission timestamps must be strictly greater than
        // ACTIVITY_DEDUP_MS — i.e. at most one emission per 1000ms window.
        for (let i = 0; i < e.emitted.length; i++) {
          for (let j = i + 1; j < e.emitted.length; j++) {
            if (e.emitted[i].summary === e.emitted[j].summary) {
              const gap = e.emitted[j].now - e.emitted[i].now;
              assert.ok(
                gap > ACTIVITY_DEDUP_MS,
                `same-summary emissions ${gap}ms apart (must be > ${ACTIVITY_DEDUP_MS}ms): ${e.emitted[i].summary}`,
              );
            }
          }
        }
        return true;
      },
    ),
    { numRuns: 200 },
  );
});

test("Property 15: dedup boundary cases (=1000ms suppresses, >1000ms admits)", () => {
  // At-the-boundary: t2 - t1 == 1000ms — second emission must be suppressed.
  {
    const e = new Emitter();
    assert.equal(e.emit("hello", 0), true);
    assert.equal(e.emit("hello", 1000), false);
    assert.equal(e.emitted.length, 1);
  }
  // Just past the boundary: t2 - t1 == 1001ms — second emission admitted.
  {
    const e = new Emitter();
    assert.equal(e.emit("hello", 0), true);
    assert.equal(e.emit("hello", 1001), true);
    assert.equal(e.emitted.length, 2);
  }
  // Distinct summaries never dedup against each other.
  {
    const e = new Emitter();
    assert.equal(e.emit("a", 0), true);
    assert.equal(e.emit("b", 100), true);
    assert.equal(e.emit("a", 200), false);
    assert.equal(e.emit("b", 200), false);
    assert.equal(e.emitted.length, 2);
  }
  // Empty sanitize result is never emitted (e.g. only control chars).
  {
    const e = new Emitter();
    assert.equal(e.emit("\x00\x01\x02", 0), false);
    assert.equal(e.emit("", 100), false);
    assert.equal(e.emitted.length, 0);
  }
});
