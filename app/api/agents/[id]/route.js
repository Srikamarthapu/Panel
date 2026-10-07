import { getWorkAgent, publicWorkAgent, updateWorkAgent } from "@/lib/work-agents.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request, { params }) {
  try {
    const agent = getWorkAgent((await params).id);
    return agent ? Response.json({ agent: publicWorkAgent(agent, { includeSoul: true }) }, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "Agent not found." }, { status: 404 });
  } catch (error) { return Response.json({ error: error.status ? error.message : "Agent could not be read." }, { status: error.status || 500 }); }
}
export async function PATCH(request, { params }) {
  try { return Response.json({ agent: publicWorkAgent(updateWorkAgent((await params).id, await request.json()), { includeSoul: true }) }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "Agent could not be updated." }, { status: error.status || 500 }); }
}
