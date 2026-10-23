import { readAgentMemoryWorkspace } from "@/lib/agent-memory.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try { return Response.json(readAgentMemoryWorkspace(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Memory and teammate context could not be read." }, { status: 500 }); }
}
