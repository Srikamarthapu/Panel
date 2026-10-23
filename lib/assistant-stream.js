import fs from "node:fs";
import path from "node:path";
import { dataDirectory } from "./work-store.js";

const valid = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export function streamFile(id) {
  if (!valid(id)) throw new Error("Invalid request ID.");
  return path.join(dataDirectory(), "assistant-runs", `${id}.stream.jsonl`);
}
export function appendAssistantText(id, value) {
  const file = streamFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ runId: id, seq: value.seq, text: value.text, messageId: value.messageId }) + "\n", { mode: 0o600 });
}
export function readAssistantText(id, after = 0) {
  return readAssistantTextChunk(id, { after }).events;
}
/** Read only bytes appended after the previous complete JSONL record. */
export function readAssistantTextChunk(id, { after = 0, offset = 0 } = {}) {
  const file = streamFile(id);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const size = fs.fstatSync(descriptor).size;
    const start = Number.isSafeInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
    if (start === size) return { events: [], offset: start };
    const bytes = Buffer.allocUnsafe(size - start);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const count = fs.readSync(descriptor, bytes, bytesRead, bytes.length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    const available = bytes.subarray(0, bytesRead);
    const lastNewline = available.lastIndexOf(0x0a);
    if (lastNewline < 0) return { events: [], offset: start };
    const consumed = available.subarray(0, lastNewline + 1);
    const events = consumed.toString("utf8").split("\n").filter(Boolean).flatMap(line => {
      try { const event = JSON.parse(line); return event.seq > after ? [event] : []; }
      catch { return []; }
    });
    return { events, offset: start + consumed.length };
  }
  catch (error) { if (error.code === "ENOENT") return { events: [], offset: 0 }; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
