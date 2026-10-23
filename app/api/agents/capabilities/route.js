import { agentCapabilityCatalog } from "@/lib/agent-capabilities.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try { return Response.json(agentCapabilityCatalog(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Agent capabilities could not be read from this Hermes installation." }, { status: 503 }); }
}
