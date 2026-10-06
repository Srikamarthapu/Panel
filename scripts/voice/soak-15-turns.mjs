#!/usr/bin/env node
// Real round trips: a queue acknowledgement is not a completed conversation.
import { pathToFileURL } from "node:url";

export async function oneTurn({ baseURL, sessionId, text, timeoutMs = 120_000, fetchImpl = fetch, pollMs = 400 }) {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(`${baseURL}/api/voice/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, sessionId, audio: false }), signal,
  });
  const data = await res.json();
  if (!res.ok || !data.actionId) throw new Error(`Request was not accepted (HTTP ${res.status}).`);
  const acknowledgedMs = Date.now() - started;
  const params = new URLSearchParams({ sessionId, actionId: data.actionId });
  for (;;) {
    const response = await fetchImpl(`${baseURL}/api/voice/runs?${params}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Result polling failed (HTTP ${response.status}).`);
    const { run } = await response.json();
    if (!run) throw new Error("Accepted run disappeared before completion.");
    if (["error", "cancelled"].includes(run.state)) throw new Error(`Run ended with ${run.state}. Inspect the local run for details.`);
    if (run.state === "complete") {
      if (typeof run.response !== "string" || !run.response.trim()) throw new Error("Completed run returned no answer.");
      return { acknowledgedMs, answerMs: Date.now() - started, replyChars: run.response.length, jevObserved: run.jev?.observed === true };
    }
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, pollMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

async function main() {
  const baseURL = process.env.BASE_URL || "http://127.0.0.1:3000";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("Use a local Panel server.");
  const turns = Number(process.env.TURNS || 15);
  if (!Number.isInteger(turns) || turns < 1 || turns > 30) throw new Error("TURNS must be between 1 and 30.");
  const sessionId = `panel-check-${Date.now()}`;
  const prompts = ["Reply with exactly READY.", "What is two plus two? One short sentence.", "Which day comes after Monday? One word."];
  const results = [];
  for (let i = 0; i < turns; i++) {
    const result = await oneTurn({ baseURL, sessionId, text: `Local reliability check. Do not use tools or change anything. ${prompts[i % prompts.length]}` });
    results.push(result);
    console.log(JSON.stringify({ turn: i + 1, ...result }));
  }
  const values = results.map(r => r.answerMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ completed: results.length, emptyAnswers: 0, minMs: values[0], medianMs: values[Math.floor(values.length / 2)], maxMs: values.at(-1), note: "Measures complete text turns; not microphone or speaker latency. Provider timing varies." }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
