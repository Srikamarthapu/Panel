import { adoptLegacyMessages, createWorkSession } from "@/lib/work-sessions.js";
import { getAssistantRun, getConversationSession } from "@/lib/assistant-runs.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "Saved conversation is required." }, { status: 400 });
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024 * 1024) { await reader.cancel(); return Response.json({ error: "Saved conversation is too large." }, { status: 413 }); }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.sessionId) || !Array.isArray(input.messages) || input.messages.length > 100) {
      return Response.json({ error: "A valid saved session and up to 100 messages are required." }, { status: 400 });
    }
    const session = createWorkSession({ id: input.sessionId, name: "Previous conversation" });
    const latest = getConversationSession(session.id).activeRunId;
    // Record a durable result before matching browser entries with different IDs.
    if (latest) getAssistantRun(latest, session.id);
    return Response.json({ session: adoptLegacyMessages(session.id, input.messages) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.status || 500;
    return Response.json({ error: status < 500 ? "The saved conversation could not be imported." : "Could not restore this conversation. Your browser copy is unchanged." }, { status });
  }
}
