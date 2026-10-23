import test from "node:test";
import assert from "node:assert/strict";
import { friendlyRunError, readHermesResult } from "../../lib/hermes-run-protocol.js";

test("terminal assistant answers preserve ordinary JSON and human Usage text", () => {
  const answer = '{"role":"label","usage":"daily","output":"measured","messages":["Usage: 3 tablets per day"]}';
  assert.deepEqual(readHermesResult({ type: "result", exit_code: 0, text: answer }), {
    state: "complete",
    response: answer,
    error: "",
  });
  assert.equal(readHermesResult({ type: "result", exit_code: 0, text: "Usage: 3 tablets per day" }).response, "Usage: 3 tablets per day");
});

test("authoritative receipt errors are not misclassified as authentication failures", () => {
  const generic = friendlyRunError("Hermes ended without an authoritative result. This request was not replayed.");
  assert.match(generic, /could not complete/i);
  assert.doesNotMatch(generic, /authenticate/i);
  assert.match(friendlyRunError("Authentication failed for the configured provider."), /authenticate/i);
  assert.match(friendlyRunError("Provider returned HTTP 401."), /authenticate/i);
  assert.doesNotMatch(friendlyRunError("trace abc401def ended"), /authenticate/i);
});
