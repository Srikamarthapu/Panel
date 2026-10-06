import { test } from "node:test";
import assert from "node:assert/strict";
import { oneTurn } from "../../scripts/voice/soak-15-turns.mjs";

function responses(values) {
  let calls = 0;
  return { fetchImpl: async () => {
    const value = values[calls++];
    assert.ok(value, "probe must not outlive its expected terminal response");
    return Response.json(value);
  }, count: () => calls };
}
test("live probe waits past queue and activity until a nonempty answer", async () => {
  const mock = responses([{ actionId: "test" }, { run: { state: "queued" } }, { run: { state: "active" } }, { run: { state: "complete", response: "READY", jev: { observed: true } } }]);
  const result = await oneTurn({ baseURL: "http://localhost", sessionId: "s", text: "ready", pollMs: 1, fetchImpl: mock.fetchImpl });
  assert.equal(mock.count(), 4);
  assert.equal(result.replyChars, 5);
  assert.equal(result.jevObserved, true);
  assert.ok(result.answerMs >= result.acknowledgedMs);
});
test("live probe rejects failed, vanished, and empty successful runs", async () => {
  for (const run of [null, { state: "error" }, { state: "cancelled" }, { state: "complete", response: "  " }]) {
    const mock = responses([{ actionId: "test" }, { run }]);
    await assert.rejects(oneTurn({ baseURL: "http://localhost", sessionId: "s", text: "ready", fetchImpl: mock.fetchImpl }));
  }
});
