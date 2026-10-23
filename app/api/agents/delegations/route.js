import { NextResponse } from "next/server";
import { stopDelegatedAgent } from "@/lib/hermes-acp-runtime.js";
import { getDelegatedAgent } from "@/lib/delegated-agents.js";
export const runtime = "nodejs";
export async function DELETE(request) {
  let input;
  try { input = await request.json(); }
  catch { return NextResponse.json({ error: "A delegated worker identity is required." }, { status: 400 }); }
  const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
  if (!input || typeof input !== "object" || Array.isArray(input) || !validId(input.sessionId) || !validId(input.runId) || !validId(input.agentId) || (input.delegationId !== undefined && !validId(input.delegationId))) {
    return NextResponse.json({ error: "A valid delegated worker identity is required." }, { status: 400 });
  }
  try { return NextResponse.json(await stopDelegatedAgent(input)); }
  catch (error) {
    const agent = getDelegatedAgent(input?.sessionId, input?.runId, input?.agentId, input?.delegationId);
    if (agent?.stopRequested && ["queued", "running"].includes(agent.status)) return NextResponse.json({ ok: true, alreadyStopping: true, agent });
    if (agent && ["complete", "error", "cancelled", "interrupted"].includes(agent.status)) return NextResponse.json({ ok: true, alreadyFinished: true, agent });
    return NextResponse.json({ error: error.message }, { status: error.status || 409 });
  }
}
