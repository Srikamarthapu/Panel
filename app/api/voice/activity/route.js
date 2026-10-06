import { addVoiceActivity, getVoiceActivity } from "@/lib/voiceActivity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId") || "";
  const limit = Number.parseInt(searchParams.get("limit") || "24", 10);
  return Response.json({
    ok: true,
    events: getVoiceActivity({ sessionId, limit }),
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    return Response.json({ ok: true, event: addVoiceActivity(body) });
  } catch (error) {
    return Response.json(
      { error: error && error.message ? error.message : "Invalid activity" },
      { status: 400 },
    );
  }
}
