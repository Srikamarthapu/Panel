// tests/property/voice-self-recovery.test.js
//
// T-0010 Law 9 (self-recovery) — pure decision helpers for the "server
// redeployed → refresh my stale bundle" flow. The imperative shell owns the
// actual window.location.reload(); these two predicates decide WHETHER an
// update exists and WHETHER now is a safe moment, so the policy is testable
// without a DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { isStaleBundle, canReloadNow } from "../../components/voice/voiceMachine.js";

test("isStaleBundle: only a real known-vs-known difference is stale", () => {
  assert.equal(isStaleBundle("abc123", "def456"), true, "different ids → stale");
  assert.equal(isStaleBundle("abc123", "abc123"), false, "same id → not stale");
});

test("isStaleBundle: unknown/blank/dev ids never trigger a reload", () => {
  assert.equal(isStaleBundle("", "abc"), false, "blank client id → no reload");
  assert.equal(isStaleBundle("abc", ""), false, "blank server id → no reload");
  assert.equal(isStaleBundle("dev", "abc"), false, "dev client → no reload");
  assert.equal(isStaleBundle("abc", "dev"), false, "dev server → no reload");
  assert.equal(isStaleBundle(null, undefined), false, "nullish → no reload");
});

test("isStaleBundle: whitespace-only difference is not a real difference", () => {
  assert.equal(isStaleBundle("abc", "  abc  "), false, "trimmed equal → not stale");
});

test("canReloadNow: only rest states are safe to reload", () => {
  assert.equal(canReloadNow("idle"), true);
  assert.equal(canReloadNow("listening"), true);
  assert.equal(canReloadNow("error"), true);
  for (const active of ["capturing", "transcribing", "thinking", "speaking"]) {
    assert.equal(canReloadNow(active), false, `${active} must HOLD the reload`);
  }
});

test("canReloadNow: starting microphone is unsafe", () => {
  assert.equal(canReloadNow("starting"), false);
});

test("Law 9 (property): a reload never fires mid-utterance/mid-speech", () => {
  const states = [
    "idle",
    "listening",
    "capturing",
    "transcribing",
    "thinking",
    "speaking",
    "error",
  ];
  const restSafe = new Set(["idle", "listening", "error"]);
  fc.assert(
    fc.property(
      fc.constantFrom(...states),
      fc.string({ maxLength: 12 }),
      fc.string({ maxLength: 12 }),
      (state, client, server) => {
        const wouldReload = isStaleBundle(client, server) && canReloadNow(state);
        if (wouldReload) {
          // Two independent guarantees: a real update exists AND we're at rest.
          assert.ok(restSafe.has(state), "auto-reload only from a rest state");
          assert.notEqual(client.trim(), server.trim());
        }
        return true;
      },
    ),
    { numRuns: 300 },
  );
});
