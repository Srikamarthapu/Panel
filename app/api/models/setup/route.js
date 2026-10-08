import { NextResponse } from "next/server";
import { hermesProviderSetup, openHermesDashboard } from "@/lib/hermes-dashboard.js";
import { isLocalApiRequestAllowed } from "@/lib/local-request.js";

export const dynamic = "force-dynamic";
export async function GET(request) {
  if (!isLocalApiRequestAllowed(request)) return NextResponse.json({ error: "Local requests only." }, { status: 403 });
  try { return NextResponse.json(hermesProviderSetup(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
}

export async function POST(request) {
  if (!isLocalApiRequestAllowed(request)) return NextResponse.json({ error: "Local requests only." }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || body.action !== "open-dashboard" || Object.keys(body).length !== 1) {
    return NextResponse.json({ error: "Choose Open Hermes dashboard to continue." }, { status: 400 });
  }
  try { return NextResponse.json(await openHermesDashboard()); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: error.status || 500 }); }
}
