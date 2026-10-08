import { ensureWorkAgentSession, publicWorkAgent } from "@/lib/work-agents.js";
import { getWorkSession, workSessionSummaryWithRun } from "@/lib/work-sessions.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const agent = ensureWorkAgentSession((await params).id);
    return Response.json({
      agent: publicWorkAgent(agent),
      session: workSessionSummaryWithRun(getWorkSession(agent.sessionId)),
    });
  } catch (error) {
    return Response.json({ error: error.status ? error.message : "The agent conversation could not be opened." }, { status: error.status || 500 });
  }
}
