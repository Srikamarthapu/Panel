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
  try { return fs.readFileSync(streamFile(id), "utf8").split("\n").filter(Boolean).flatMap(line => { try { const event = JSON.parse(line); return event.seq > after ? [event] : []; } catch { return []; } }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
