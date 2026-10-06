import { getVoiceConfig, saveVoiceConfig } from "@/lib/voice";
import { startAssistantRun } from "@/lib/assistant-launch.js";
import { createWorkSession, getWorkSession } from "@/lib/work-sessions.js";
import { MAX_USER_TEXT, MAX_ASSISTANT_TEXT } from "@/lib/conversation-limits";
import { publicReplyText } from "@/lib/publicReply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const publicFields = ["ttsBackend", "ttsVoice", "ttsRate", "ttsPitch", "ttsVolume", "elevenlabsVoiceId", "elevenlabsModel", "sttBackend", "sttLanguage", "voiceModelProvider", "voiceModel", "voiceReasoningEffort", "micDeviceId", "speakerDeviceId", "muteOutput", "autoSpeak", "enabled"];
function publicConfig(config) { return Object.fromEntries(publicFields.map(key => [key, config[key]])); }
function historyContext(history, text) {
  const entries = (Array.isArray(history) ? history : []).slice(-24);
  // The client has already appended the submitted user message to its log.
  // Do not import it twice when creating the first persistent Hermes session.
  if (entries.at(-1)?.role === "user" && String(entries.at(-1).content || entries.at(-1).text || "").trim() === text) entries.pop();
  return entries.flatMap(entry => {
    if (!entry || !["user", "assistant", "hermes"].includes(entry.role) || entry.isError || entry.pending) return [];
    const value = String(entry.content || entry.text || "");
    const content = entry.role === "user" ? value.slice(0, MAX_USER_TEXT) : publicReplyText(value).slice(0, MAX_ASSISTANT_TEXT);
    return content.trim() ? [{ role: entry.role === "user" ? "user" : "assistant", content }] : [];
  });
}
/** Every turn uses Hermes's actual tools and resumes the same conversation.
 * Acknowledgements are status only; the terminal result arrives via /runs. */
export async function POST(request) {
  try {
    const body = await request.json();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!text) return Response.json({ error: "Enter a message first." }, { status: 400 });
    if (text.length > MAX_USER_TEXT) return Response.json({ error: `Messages can contain up to ${MAX_USER_TEXT.toLocaleString()} characters. Split this message into parts.` }, { status: 400 });
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return Response.json({ error: "A valid conversation ID is required. Reload the page and try again." }, { status: 400 });
    if (body.actionId && (typeof body.actionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.actionId))) return Response.json({ error: "Invalid request ID." }, { status: 400 });
    // Adopt an older browser conversation without changing its Hermes mapping.
    if (!getWorkSession(sessionId)) createWorkSession({ id: sessionId, name: "Chat session" });
    const textOnly = body.audio === false || !(body.audio === true || body.streamAudio === true);
    const run = await startAssistantRun({ id: body.actionId, sessionId, text, textOnly, history: historyContext(body.history, text) });
    return Response.json({ response: run.response || "", sessionId, mode: "action", actionId: run.id, pending: ["queued", "active"].includes(run.state), statusLabel: run.statusLabel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.status ? error.message : "The local assistant could not start this request. Try again." }, { status: error.status || 500 });
  }
}
export function GET() { return Response.json({ config: publicConfig(getVoiceConfig()) }); }
export async function PUT(request) {
  try {
    const body = await request.json();
    const patch = Object.fromEntries(publicFields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    return Response.json({ config: publicConfig(saveVoiceConfig(patch)) });
  } catch { return Response.json({ error: "Voice settings could not be saved." }, { status: 400 }); }
}
