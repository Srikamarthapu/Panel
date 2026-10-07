import { getWorkSession, updateWorkSession, recordSessionRun, workSessionSummaryWithRun } from "@/lib/work-sessions.js";
import { assistantRunIsExecuting, getAssistantRun, getConversationSession, publicAssistantRun } from "@/lib/assistant-runs.js";
import { updateWorkAgent } from "@/lib/work-agents.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function activeRunFor(id) {
  const runId = getConversationSession(id).activeRunId;
  return runId ? getAssistantRun(runId, id) : null;
}
export async function GET(request, context) {
  try {
    const { id } = await context.params;
    const run = activeRunFor(id);
    recordSessionRun(run);
    const saved = getWorkSession(id);
    if (!saved) return Response.json({ error: "Session not found." }, { status: 404 });
    const activeRun = run && (["queued", "active"].includes(run.state) || assistantRunIsExecuting(run)) ? publicAssistantRun(run) : null;
    return Response.json({ session: workSessionSummaryWithRun(saved), messages: saved.messages, activeRun }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Session could not be read." }, { status: 500 }); }
}
export async function PATCH(request, context) {
  try {
    const { id } = await context.params;
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: "A session object is required." }, { status: 400 });
    const session = getWorkSession(id);
    if (session?.agentId && ["name", "workingDirectory", "archived"].some(key => Object.hasOwn(input, key))) {
      updateWorkAgent(session.agentId, Object.fromEntries(["name", "workingDirectory", "archived"].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])));
      return Response.json({ session: workSessionSummaryWithRun(getWorkSession(id)) });
    }
    return Response.json({ session: workSessionSummaryWithRun(updateWorkSession(id, input)) });
  } catch (error) { return Response.json({ error: error.status ? error.message : "Session could not be saved." }, { status: error.status || 500 }); }
}
