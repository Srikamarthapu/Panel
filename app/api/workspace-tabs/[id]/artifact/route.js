import { readWorkspaceTabArtifact } from "@/lib/workspace-tabs.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request, { params }) {
  try { return Response.json(readWorkspaceTabArtifact((await params).id, { preview: new URL(request.url).searchParams.get("preview") === "true" }), { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "The tab preview could not be read." }, { status: error.status || 500 }); }
}
