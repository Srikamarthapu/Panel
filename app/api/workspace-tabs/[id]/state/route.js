import { readWorkspaceTabState, saveWorkspaceTabState } from "@/lib/workspace-tabs.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request, { params }) {
  try { return Response.json({ value: readWorkspaceTabState((await params).id) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "Tab data could not be read." }, { status: error.status || 500 }); }
}
export async function PUT(request, { params }) {
  try { const body = await request.text(); if (Buffer.byteLength(body, "utf8") > 100100) return Response.json({ error: "Tab data is too large." }, { status: 413 }); saveWorkspaceTabState((await params).id, JSON.parse(body).value); return Response.json({ saved: true }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "Tab data could not be saved." }, { status: error.status || 500 }); }
}
