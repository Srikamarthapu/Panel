import { runWorkAgent, workAgentRun } from "@/lib/agent-actions.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request, { params }) {
  try { return Response.json(await runWorkAgent((await params).id, await request.json()), { status: 202 }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "The agent could not start this task." }, { status: error.status || 500 }); }
}
export async function DELETE(request, { params }) {
  try { const input = await request.json(); return Response.json(workAgentRun((await params).id, input.runId, { stop: true })); }
  catch (error) { return Response.json({ error: error.status ? error.message : "The agent could not be stopped." }, { status: error.status || 500 }); }
}
