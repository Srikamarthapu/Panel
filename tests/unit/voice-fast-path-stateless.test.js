// tests/unit/voice-fast-path-stateless.test.js
//
// T-0010 Law 7 ("no degradation"): the streaming fast path must NOT accumulate
// per-session conversation history in memory — an unbounded history would make
// turn 50 slower than turn 1 and eventually blow the model's context. The
// Live soak (scripts/voice/soak-15-turns.mjs) measures completed turns; latency varies
// empirically; this test proves the mechanism: the request the fast path sends
// to the model is ALWAYS exactly [system, user] — no growing message array —
// no matter how many turns share a session.
//
// If a future change adds server-side history to the fast path, it MUST also
// cap it (spec: last ~12 turns). This test then becomes the reminder to update
// the cap assertion rather than leave it unbounded.

import { test } from "node:test";
import assert from "node:assert/strict";

import { streamVoiceModelTokens } from "../../lib/voice.js";

// A mock model endpoint that captures each request body and streams a tiny
// SSE reply so streamVoiceModelTokens completes.
function makeMockFetch(captured) {
  return async (_url, init) => {
    captured.push(JSON.parse(init.body));
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "ok." } }] })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

// resolveVoiceModelConfig reads the provider's API key from an env var; set
// one so the request builds. openai's providerDefault supplies baseUrl+envKey
// even for an unknown model, so this resolves without touching the network.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-soak";
const CONFIG = {
  voiceModelProvider: "openai",
  voiceModel: "gpt-test",
};

async function drain(gen) {
  let out = "";
  for await (const t of gen) out += t;
  return out;
}

test("Law 7: fast path sends exactly [system, user] every turn (no history growth)", async () => {
  const captured = [];
  const fetchImpl = makeMockFetch(captured);

  // Simulate 20 sequential turns on the SAME logical session. If history
  // accumulated, later request bodies would carry more messages.
  for (let i = 0; i < 20; i += 1) {
    await drain(
      streamVoiceModelTokens({
        text: `turn number ${i}`,
        config: CONFIG,
        fetchImpl,
        systemPrompt: "SYS",
      }),
    );
  }

  assert.equal(captured.length, 20, "all 20 turns hit the model");
  for (let i = 0; i < captured.length; i += 1) {
    const msgs = captured[i].messages;
    assert.ok(Array.isArray(msgs), `turn ${i} has a messages array`);
    assert.equal(
      msgs.length,
      2,
      `turn ${i}: exactly [system, user] — no accumulated history (got ${msgs.length})`,
    );
    assert.equal(msgs[0].role, "system");
    assert.equal(msgs[1].role, "user");
    assert.equal(msgs[1].content, `turn number ${i}`, "only the current turn's text is sent");
  }
});

test("Law 7: the last turn's request is no larger than the first (flat, not growing)", async () => {
  const captured = [];
  const fetchImpl = makeMockFetch(captured);
  for (let i = 0; i < 12; i += 1) {
    await drain(
      streamVoiceModelTokens({
        text: "same length prompt here",
        config: CONFIG,
        fetchImpl,
        systemPrompt: "SYS",
      }),
    );
  }
  const first = JSON.stringify(captured[0]).length;
  const last = JSON.stringify(captured[captured.length - 1]).length;
  assert.equal(last, first, "request payload size is constant across turns");
});
