import { runHermesCommand } from "@/lib/hermes-command.js";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const out = await runHermesCommand(["gateway", "restart"], { timeout: 20000 });
    return NextResponse.json({ ok: true, output: out });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
