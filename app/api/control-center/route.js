import { getControlCenterSnapshot } from "@/lib/control-center.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getControlCenterSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
