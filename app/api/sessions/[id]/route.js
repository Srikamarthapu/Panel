import { getWorkSession, updateWorkSession, recordSessionRun, workSessionSummaryWithRun } from "@/lib/work-sessions.js";
import { assistantRunIsExecuting, getAssistantRun, getConversationSession, publicAssistantRun } from "@/lib/assistant-runs.js";
import { getWorkAgent, updateWorkAgent } from "@/lib/work-agents.js";
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
    const agent = session?.agentId ? getWorkAgent(session.agentId) : null;
    // The current agent conversation shares its display name and folder with
    // the profile. Pin/archive are conversation lifecycle only; historical
    // agent conversations never mutate the profile they came from.
    if (agent?.sessionId === id && ["name", "workingDirectory"].some(key => Object.hasOwn(input, key))) {
      const shared = Object.fromEntries(["name", "workingDirectory"].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
      updateWorkAgent(session.agentId, shared);
      const sessionOnly = Object.fromEntries(Object.entries(input).filter(([key]) => !Object.hasOwn(shared, key)));
      if (Object.keys(sessionOnly).length) updateWorkSession(id, sessionOnly);
      return Response.json({ session: workSessionSummaryWithRun(getWorkSession(id)) });
    }
    const saved = updateWorkSession(id, input);
    return Response.json({ session: workSessionSummaryWithRun(saved) });
  } catch (error) { return Response.json({ error: error.status ? error.message : "Session could not be saved." }, { status: error.status || 500 }); }
}
