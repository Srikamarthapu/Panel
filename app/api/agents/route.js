import { createWorkAgent, listWorkAgents, publicWorkAgent } from "@/lib/work-agents.js";
import { listDelegatedAgents } from "@/lib/delegated-agents.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request) {
  try { return Response.json({ agents: listWorkAgents({ includeArchived: new URL(request.url).searchParams.get("archived") === "true" }), delegations: listDelegatedAgents() }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Agent profiles could not be read." }, { status: 500 }); }
}
export async function POST(request) {
  try { return Response.json({ agent: publicWorkAgent(createWorkAgent(await request.json()), { includeSoul: true }) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "The agent could not be created." }, { status: error.status || 500 }); }
}
