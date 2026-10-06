import { readCapabilities } from "@/lib/capabilities.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await readCapabilities(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error.message }, { status: 503 }); }
}
