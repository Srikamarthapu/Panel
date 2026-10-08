import { workspaceTabDetails } from "@/lib/workspace-tabs.js";
import { changeWorkspaceTab, workspaceTabAction } from "@/lib/workspace-tab-actions.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const failure = error => Response.json({ error: error.status ? error.message : "This tab could not be updated. Try again." }, { status: error.status || 500 });
export async function GET(request, { params }) {
  try { return Response.json(workspaceTabDetails((await params).id), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failure(error); }
}
export async function POST(request, { params }) {
  try { return Response.json(await workspaceTabAction((await params).id, await request.json()), { status: 202 }); } catch (error) { return failure(error); }
}
export async function PATCH(request, { params }) {
  try { return Response.json({ tab: changeWorkspaceTab((await params).id, await request.json()) }); } catch (error) { return failure(error); }
}
