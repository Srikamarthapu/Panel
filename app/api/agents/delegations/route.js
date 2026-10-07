import { NextResponse } from "next/server";
import { stopDelegatedAgent } from "@/lib/hermes-acp-runtime.js";
export const runtime = "nodejs";
export async function DELETE(request) {
  try { return NextResponse.json(await stopDelegatedAgent(await request.json())); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: error.status || 409 }); }
}
