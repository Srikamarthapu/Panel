import test from "node:test";
import assert from "node:assert/strict";
import { createRunOutcome } from "../../lib/run-outcome.js";
import { shouldShowChatOutcome } from "../../lib/chat-outcome.js";

test("Chat hides review chrome for a plain successful reply", () => {
  const greeting = createRunOutcome({ state: "complete", response: "Hello there.", updatedAt: "2026-10-15T12:00:00.000Z" });
  assert.equal(shouldShowChatOutcome(greeting), false);
});

test("Chat keeps review access for evidence and unsuccessful work", () => {
  const withReceipt = createRunOutcome({
    state: "complete",
    response: "Updated the file.",
    updatedAt: "2026-10-15T12:00:00.000Z",
    outcomeEvidence: { verifiedItems: [{ kind: "file", path: "/project/app.js", source: "runtime_receipt", label: "edit completed" }] },
  });
  const failed = createRunOutcome({ state: "error", error: "The command failed.", updatedAt: "2026-10-15T12:00:00.000Z" });
  assert.equal(shouldShowChatOutcome(withReceipt), true);
  assert.equal(shouldShowChatOutcome(failed), true);
});

test("Chat keeps review access when the runtime reports a different model", () => {
  const outcome = createRunOutcome({ state: "complete", response: "Done.", requestedProvider: "provider-a", requestedModel: "model-a", selectedProvider: "provider-b", selectedModel: "model-b", selectedModelProvenance: "runtime" });
  assert.equal(shouldShowChatOutcome(outcome), true);
});
