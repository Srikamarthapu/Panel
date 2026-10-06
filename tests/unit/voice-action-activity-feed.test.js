import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// T-0006 scope rule: voice/action completions must surface in the store the
// live activity feed actually renders WITHOUT writing to orchestrator/**.
// The T-0003 activity ticker's action console (VoiceActionConsole) polls
// /api/voice/activity, which serves getVoiceActivity() from
// data/voice-activity.json. So the completion must land there — and it must
// NOT touch orchestrator/ledger/runs.jsonl (a forbidden runtime write target).
test("T-0006 action-path completion lands in the voice activity feed store, not orchestrator/**", async () => {
  const originalCwd = process.cwd();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "voice-action-feed-"));

  try {
    process.chdir(tmp);
    const cacheBust = Date.now();
    const { addVoiceActivity, getVoiceActivity } = await import(
      `../../lib/voiceActivity.js?activity=${cacheBust}`
    );

    addVoiceActivity({
      id: "qa-action-complete",
      sessionId: "qa-session",
      kind: "tool",
      state: "complete",
      title: "Hermes action complete",
      summary: "qa completion should be visible in the dashboard feed",
      target: "hermes",
      source: "voice/action",
    });

    // The event surfaces through the store the action console reads.
    const events = getVoiceActivity({ sessionId: "qa-session", limit: 16 });
    const match = events.find((event) => event.id === "qa-action-complete");
    assert.ok(
      match,
      "voice action completion must be readable via getVoiceActivity (data/voice-activity.json), the store VoiceActionConsole renders",
    );
    assert.equal(match.state, "complete");
    assert.equal(match.source, "voice/action");

    // Scope guarantee: no write escaped into orchestrator/** at runtime.
    let ledgerContents = "";
    try {
      ledgerContents = readFileSync(
        path.join(tmp, "orchestrator", "ledger", "runs.jsonl"),
        "utf8",
      );
    } catch {
      ledgerContents = "";
    }
    assert.equal(
      ledgerContents,
      "",
      "voice activity must NOT write to orchestrator/ledger/runs.jsonl (forbidden write target)",
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("tool activity preserves correlation and source time for truthful live status", async () => {
  const originalCwd = process.cwd();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "voice-tool-feed-"));
  try {
    process.chdir(tmp);
    const { addVoiceActivity, getVoiceActivity } = await import(`../../lib/voiceActivity.js?tool=${Date.now()}`);
    const ts = "2026-07-01T10:00:00Z";
    addVoiceActivity({ id: "tool-start", sessionId: "s1", source: "hermes/tool", state: "active", toolName: "web_search", callId: "call-1", ts });
    addVoiceActivity({ id: "tool-result", sessionId: "s1", source: "hermes/tool", state: "done", toolName: "web_search", callId: "call-1", ts });
    const [result, start] = getVoiceActivity({ sessionId: "s1" });
    assert.equal(start.toolName, "web_search");
    assert.equal(start.callId, result.callId);
    assert.equal(start.updatedAt, "2026-07-01T10:00:00.000Z");
    assert.equal(result.state, "done");
  } finally {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});
