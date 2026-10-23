import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-assistant-stream-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "data");
const streams = await import("../../lib/assistant-stream.js");
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("assistant stream readers advance by complete JSONL byte offsets", () => {
  streams.appendAssistantText("run-one", { seq: 1, text: "one", messageId: "message" });
  streams.appendAssistantText("run-one", { seq: 2, text: "two ✓", messageId: "message" });
  const first = streams.readAssistantTextChunk("run-one", { after: 1 });
  assert.deepEqual(first.events.map(event => event.seq), [2]);
  const settled = streams.readAssistantTextChunk("run-one", { after: 2, offset: first.offset });
  assert.deepEqual(settled, { events: [], offset: first.offset });

  const file = streams.streamFile("run-one");
  const third = JSON.stringify({ runId: "run-one", seq: 3, text: "three", messageId: "message" });
  fs.appendFileSync(file, third);
  const partial = streams.readAssistantTextChunk("run-one", { after: 2, offset: first.offset });
  assert.deepEqual(partial, { events: [], offset: first.offset });
  fs.appendFileSync(file, "\n");
  const completed = streams.readAssistantTextChunk("run-one", { after: 2, offset: partial.offset });
  assert.deepEqual(completed.events.map(event => event.seq), [3]);
  assert.ok(completed.offset > first.offset);
  assert.deepEqual(streams.readAssistantText("run-one", 1).map(event => event.seq), [2, 3]);
});

test("missing assistant streams retain the incremental contract", () => {
  assert.deepEqual(streams.readAssistantTextChunk("missing", { after: 4, offset: 100 }), { events: [], offset: 0 });
});

test("assistant stream readers handle short reads without scanning uninitialized bytes", () => {
  streams.appendAssistantText("short-read", { seq: 1, text: "multibyte ✓ café", messageId: "message" });
  const originalReadSync = fs.readSync;
  fs.readSync = (descriptor, buffer, offset, length, position) =>
    originalReadSync(descriptor, buffer, offset, Math.min(length, 3), position);
  try {
    const result = streams.readAssistantTextChunk("short-read");
    assert.deepEqual(result.events.map(event => event.text), ["multibyte ✓ café"]);
    assert.equal(result.offset, fs.statSync(streams.streamFile("short-read")).size);
  } finally {
    fs.readSync = originalReadSync;
  }
});

test("assistant stream readers do not advance after a concurrent truncate", () => {
  streams.appendAssistantText("truncated-read", { seq: 1, text: "discarded", messageId: "message" });
  const file = streams.streamFile("truncated-read");
  const originalReadSync = fs.readSync;
  let truncated = false;
  fs.readSync = (descriptor, buffer, offset, length, position) => {
    if (!truncated) {
      truncated = true;
      fs.truncateSync(file, 0);
    }
    return originalReadSync(descriptor, buffer, offset, length, position);
  };
  try {
    assert.deepEqual(streams.readAssistantTextChunk("truncated-read"), { events: [], offset: 0 });
  } finally {
    fs.readSync = originalReadSync;
  }
});
