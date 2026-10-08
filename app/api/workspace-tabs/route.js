import { createWorkspaceTab, listWorkspaceTabs } from "@/lib/workspace-tabs.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request) {
  try { return Response.json({ tabs: listWorkspaceTabs({ archived: new URL(request.url).searchParams.get("archived") === "true" }) }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Workspace tabs could not be read." }, { status: 500 }); }
}
export async function POST(request) {
  try { return Response.json({ tab: createWorkspaceTab(await request.json()) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error.status ? error.message : "The tab could not be created." }, { status: error.status || 500 }); }
}
