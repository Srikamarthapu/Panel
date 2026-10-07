import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceFeedbackHandoff } from "../../components/voice/voiceFeedbackPlayback.js";

test("retiring an acknowledgement before playback starts cancels its pending preparation", async () => {
  let stops = 0;
  const handoff = createVoiceFeedbackHandoff({ cancelPlayback: () => { stops += 1; } });
  assert.equal(handoff.retire(), true);
  assert.equal(await handoff.done, "retired");
  assert.equal(handoff.markStarted(), false);
  assert.equal(stops, 1);
});

test("retiring a started acknowledgement lets it finish while answer audio is prepared", async () => {
  const handoff = createVoiceFeedbackHandoff({ maxWaitMs: 100 });
  assert.equal(handoff.markStarted(), true);
  assert.equal(handoff.started, true);
  assert.equal(handoff.retire(), false);
  let waited = false;
  const waiting = handoff.wait().then((reason) => { waited = true; return reason; });
  await Promise.resolve();
  assert.equal(waited, false);
  assert.equal(handoff.finish(), true);
  assert.equal(await waiting, "finished");
});

test("explicit cancellation stops a started acknowledgement and settles waiters once", async () => {
  let stops = 0;
  const handoff = createVoiceFeedbackHandoff({ cancelPlayback: () => { stops += 1; } });
  handoff.markStarted();
  const waiting = handoff.wait();
  assert.equal(handoff.cancel(), true);
  assert.equal(handoff.cancel(), false);
  assert.equal(await waiting, "cancelled");
  assert.equal(await handoff.done, "cancelled");
  assert.equal(stops, 1);
});

test("a stuck acknowledgement is stopped after the bounded handoff wait", async () => {
  let stops = 0;
  const handoff = createVoiceFeedbackHandoff({ cancelPlayback: () => { stops += 1; }, maxWaitMs: 5 });
  handoff.markStarted();
  assert.equal(await handoff.wait(), "cancelled");
  assert.equal(stops, 1);
});
