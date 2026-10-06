import test from "node:test";
import assert from "node:assert/strict";
import { collectFormattedTextReply } from "../../lib/voiceTextReply.js";

test("typed model replies retain markdown, line breaks, and text beyond the voice ceiling", async () => {
  const parts = ["## Findings\n\n", "**Important** details:\n\n", "```js\nconst answer = 42;\n```\n", "x".repeat(6000)];
  async function* modelTokens() { yield* parts; }
  const result = await collectFormattedTextReply(modelTokens());
  assert.equal(result, parts.join(""));
  assert.ok(result.length > 6000);
});

test("collector closes the model iterator at 64000 characters", async () => {
  let closed = false;
  let produced = 0;
  async function* modelTokens() {
    try {
      while (true) { produced += 1; yield "a".repeat(1500); }
    } finally { closed = true; }
  }
  const result = await collectFormattedTextReply(modelTokens());
  assert.equal(result.length, 64000);
  assert.equal(produced, 43);
  assert.equal(closed, true);
});

test("model stream failures remain visible to the route error handler", async () => {
  async function* failedStream() { yield "Partial"; throw new Error("Connection lost"); }
  await assert.rejects(collectFormattedTextReply(failedStream()), /Connection lost/);
});

test("character ceiling does not emit a broken emoji", async () => {
  async function* modelTokens() { yield "a".repeat(7999); yield "🌎"; }
  assert.equal(await collectFormattedTextReply(modelTokens(), 8000), "a".repeat(7999));
});
