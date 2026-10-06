import test from "node:test";
import assert from "node:assert/strict";
import { assistantFinalText, publicReplyText, publicReplyTokens, normalizeTranscriptEntries } from "../../lib/publicReply.js";

test("structured final selection excludes tool calls, tool results, reasoning and usage", () => {
  const messages = [
    { role: "assistant", content: "Let me search.", tool_calls: [{ function: { name: "search", arguments: "{}" } }] },
    { role: "tool", content: "Raw result" },
    { role: "assistant", content: "Your meeting starts at noon." },
    { type: "usage", text: "1000 tokens" },
  ];
  assert.equal(assistantFinalText(messages), "Your meeting starts at noon.");
  assert.equal(assistantFinalText({ role: "assistant", channel: "analysis", content: "Internal reasoning" }), "");
  assert.equal(publicReplyText(JSON.stringify({ tool_calls: [{ name: "search" }], usage: { total_tokens: 123 } })), "");
});

test("raw internal blocks are removed without altering a final answer", () => {
  const raw = '<think>I should use a tool.</think><tool_call>{"name":"search","arguments":{"q":"calendar"}}</tool_call>Your meeting starts at noon.';
  assert.equal(publicReplyText(raw), "Your meeting starts at noon.");
  assert.equal(publicReplyText('<function=search><parameter=q>private</parameter></function>Done.'), "Done.");
  assert.equal(publicReplyText('Usage: prompt_tokens=123 completion_tokens=45\nAll done.'), "All done.");
});

test("normal code, HTML examples, tool explanations and JSON data remain visible", () => {
  for (const reply of [
    'Use this code:\n```xml\n<tool_call>example</tool_call>\n```\nThen run it.',
    '```js\nconst usage = { total: 10 };\nconsole.log(usage);\n```',
    '{"name":"search","description":"A user-provided object"}',
    'The tool reported three results. Use <button> for an action.',
  ]) assert.equal(publicReplyText(reply), reply);
});

test("stream guard never emits protocol even when delimiters arrive character by character", async () => {
  const rawReplies = [
    '<｜DSML｜function_calls><｜DSML｜invoke name="skill_view"><｜DSML｜parameter name="name" string="true">google-workspace</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>Finished safely.',
    '< | | DSML | | calls>< | | DSML | | invoke name="skill_view">hidden</ | | DSML | | invoke></ | | DSML | | calls>Finished safely.',
    '<think>Private. Reasoning.</think><tool_call>{"name":"search"}</tool_call>Finished safely.',
    '<｜tool▁calls▁begin｜>search{}<｜tool▁calls▁end｜>Finished safely.',
    '[TOOL_CALLS]{"name":"search"}[/TOOL_CALLS]Finished safely.',
    '<|start|>assistant<|channel|>analysis<|message|>Private reasoning.<|end|><|start|>assistant<|channel|>final<|message|>Finished safely.',
    'Usage: prompt_tokens=123\nFinished safely.',
  ];
  for (const raw of rawReplies) {
    async function* tokens() { yield* raw; }
    let output = "";
    for await (const token of publicReplyTokens(tokens())) output += token;
    assert.equal(output, "Finished safely.", raw);
  }
});

test("an unfinished current turn never replays the previous assistant answer", () => {
  assert.equal(assistantFinalText([{ role: "assistant", content: "Old answer" }, { role: "user", content: "New request" }, { role: "assistant", tool_calls: [{ name: "search" }], content: "Searching" }]), "");
});

test("history retains long messages and repairs old speech error attribution", () => {
  const [user, assistant, error] = normalizeTranscriptEntries([
    { role: "user", text: "a".repeat(32000) },
    { role: "hermes", text: "b".repeat(12000) },
    { role: "user", text: '{"error":"STT request failed","details":"fetch failed"}' },
  ]);
  assert.equal(user.text.length, 32000);
  assert.equal(assistant.text.length, 12000);
  assert.equal(error.role, "hermes");
  assert.equal(error.isError, true);
});

test("ordinary text still streams immediately", async () => {
  let reads = 0;
  async function* tokens() { reads += 1; yield "Hello there. "; reads += 1; yield "The answer is ready."; }
  const filtered = publicReplyTokens(tokens());
  assert.equal((await filtered.next()).value, "Hello there. ");
  assert.equal(reads, 1);
});

test("persisted history removes internal assistant entries, preserves user text, and dedupes ids", () => {
  const entries = normalizeTranscriptEntries([
    { id: "u", role: "user", text: "Explain <tool_call> syntax" },
    { id: "raw", role: "hermes", text: '<tool_call>{"name":"search"}</tool_call>' },
    { id: "done", role: "hermes", text: "Earlier", audioUrl: "blob:expired" },
    { id: "done", role: "hermes", text: "Final answer" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.text), ["Explain <tool_call> syntax", "Final answer"]);
  assert.equal(entries[1].audioUrl, undefined);
});
