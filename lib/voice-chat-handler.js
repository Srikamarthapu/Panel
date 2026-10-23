import { startAssistantRun } from "./assistant-launch.js";
import { MAX_USER_TEXT, MAX_ASSISTANT_TEXT } from "./conversation-limits.js";
import { publicReplyText } from "./publicReply.js";
import { createWorkSession, getWorkSession } from "./work-sessions.js";

function historyContext(history, text) {
  const entries = (Array.isArray(history) ? history : []).slice(-24);
  if (entries.at(-1)?.role === "user" && String(entries.at(-1).content || entries.at(-1).text || "").trim() === text) entries.pop();
  return entries.flatMap(entry => {
    if (!entry || !["user", "assistant", "hermes"].includes(entry.role) || entry.isError || entry.pending) return [];
    const value = String(entry.content || entry.text || "");
    const content = entry.role === "user" ? value.slice(0, MAX_USER_TEXT) : publicReplyText(value).slice(0, MAX_ASSISTANT_TEXT);
    return content.trim() ? [{ role: entry.role === "user" ? "user" : "assistant", content }] : [];
  });
}

export async function handleVoiceChatRequest(request, { start = startAssistantRun } = {}) {
  try {
    const body = await request.json();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!text) return Response.json({ error: "Enter a message first." }, { status: 400 });
    if (text.length > MAX_USER_TEXT) return Response.json({ error: `Messages can contain up to ${MAX_USER_TEXT.toLocaleString()} characters. Split this message into parts.` }, { status: 400 });
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return Response.json({ error: "A valid conversation ID is required. Reload the page and try again." }, { status: 400 });
    if (body.actionId && (typeof body.actionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.actionId))) return Response.json({ error: "Invalid request ID." }, { status: 400 });
    if (body.surface != null && !["chat", "talk"].includes(body.surface)) return Response.json({ error: "Surface must be Chat or Talk." }, { status: 400 });
    if (!getWorkSession(sessionId)) createWorkSession({ id: sessionId, name: "Chat session" });
    const textOnly = body.audio === false || !(body.audio === true || body.streamAudio === true);
    const run = await start({ id: body.actionId, sessionId, text, textOnly, surface: body.surface, history: historyContext(body.history, text) });
    return Response.json({ response: run.response || "", sessionId, mode: "action", actionId: run.id, pending: ["queued", "active"].includes(run.state), statusLabel: run.statusLabel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.status ? error.message : "The local assistant could not start this request. Try again." }, { status: error.status || 500 });
  }
}
