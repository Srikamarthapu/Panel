import { cancelAssistantRun, getAssistantRun, getConversationSession, publicAssistantRun } from "@/lib/assistant-runs";
import { addVoiceActivity } from "@/lib/voiceActivity";

export const dynamic = "force-dynamic";
export function GET(request) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get("sessionId");
  if (!sessionId || sessionId.length > 200) return Response.json({ error: "A conversation is required." }, { status: 400 });
  const id = params.get("actionId") || getConversationSession(sessionId).activeRunId;
  const run = id ? getAssistantRun(id, sessionId) : null;
  return Response.json({ run: publicAssistantRun(run) }, { headers: { "Cache-Control": "no-store" } });
}
export async function DELETE(request) {
  try {
    const { sessionId, actionId } = await request.json();
    if (!sessionId || !actionId) return Response.json({ error: "A conversation and request are required." }, { status: 400 });
    const run = cancelAssistantRun(actionId, sessionId);
    if (!run) return Response.json({ error: "Request not found." }, { status: 404 });
    if (run.state === "cancelled") addVoiceActivity({ id: `${run.id}:failed`, sessionId, kind: "error", state: "error", title: "Request stopped", summary: run.error, source: "voice/action", textOnly: true });
    return Response.json({ run: publicAssistantRun(run) });
  } catch { return Response.json({ error: "Could not stop this request." }, { status: 400 }); }
}
