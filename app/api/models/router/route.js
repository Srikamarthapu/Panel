import { NextResponse } from "next/server";
import { getJevRouterStatus, saveJevRouterConfig } from "@/lib/jev-router.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ...getJevRouterStatus() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request) {
  // A browser on another site must not be able to replace a local credential.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin) {
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ error: "Open these settings from Hermes Control." }, { status: 403 });
    } catch { return NextResponse.json({ error: "Invalid origin." }, { status: 403 }); }
  }
  if (!request.headers.get("content-type")?.includes("application/json")) return NextResponse.json({ error: "Expected JSON settings." }, { status: 415 });
  const raw = await request.text();
  if (raw.length > 4096) return NextResponse.json({ error: "Settings are too large." }, { status: 413 });
  try {
    return NextResponse.json({ ok: true, ...saveJevRouterConfig(JSON.parse(raw)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = /^(Provide|Enabled|Remove key|Enter|Add your)/.test(error.message) ? error.message : "Jev settings could not be saved.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
