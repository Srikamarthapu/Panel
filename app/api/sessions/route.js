import { createWorkSession, listWorkSessions } from "@/lib/work-sessions.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  try { return Response.json({ sessions: listWorkSessions() }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Saved sessions could not be read." }, { status: 500 }); }
}
export async function POST(request) {
  try {
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: "A session object is required." }, { status: 400 });
    const session = createWorkSession({ name: input.name, workingDirectory: input.workingDirectory });
    return Response.json({ session }, { status: 201 });
  } catch (error) { return Response.json({ error: error.status ? error.message : "Session could not be created." }, { status: error.status || 500 }); }
}
