import { cancelWorkTask, createWorkTask, listWorkTasks, queueWorkerStatus } from "@/lib/work-queue.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  try { return Response.json({ tasks: listWorkTasks(), worker: queueWorkerStatus() }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Saved tasks could not be read." }, { status: 500 }); }
}
export async function POST(request) {
  try {
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: "A task object is required." }, { status: 400 });
    return Response.json({ task: createWorkTask(input) }, { status: 201 });
  } catch (error) { return Response.json({ error: error.status ? error.message : "Task could not be saved." }, { status: error.status || 500 }); }
}
export async function PATCH(request) {
  try {
    const input = await request.json();
    if (input?.action !== "cancel" || typeof input.id !== "string") return Response.json({ error: "A task ID and cancel action are required." }, { status: 400 });
    return Response.json({ task: cancelWorkTask(input.id) });
  } catch (error) { return Response.json({ error: error.status ? error.message : "Task could not be cancelled." }, { status: error.status || 500 }); }
}
