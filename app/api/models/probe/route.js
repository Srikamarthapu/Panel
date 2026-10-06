import { NextResponse } from "next/server";
import { probeModelSelection } from "@/lib/model-catalog.js";

export const runtime = "nodejs";

export async function POST(request) {
  const input = await request.json().catch(() => ({}));
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose one configured model to test.");
    const result = await probeModelSelection(input, { signal: request.signal });
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status || 400 });
  }
}
