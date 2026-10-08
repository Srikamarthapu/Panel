import { onboardingEnvironment, onboardingState, saveOnboardingDecision } from "@/lib/onboarding.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json({ ok: true, ...onboardingState(), ...onboardingEnvironment() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "Panel could not read first-run settings." }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: "An onboarding outcome is required." }, { status: 400 });
    return Response.json({ ok: true, decision: saveOnboardingDecision(input.outcome) });
  } catch (error) {
    const invalid = error.message === "Choose a valid onboarding outcome.";
    return Response.json({ error: invalid ? error.message : "Panel could not save first-run settings." }, { status: invalid ? 400 : 500 });
  }
}
