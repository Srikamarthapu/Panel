import { getDirectConfig, publicDirectConfig, saveDirectConfig } from "@/lib/direct-config.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try { return Response.json({ config: publicDirectConfig(getDirectConfig()) }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Panel could not read direct connection settings." }, { status: 500 }); }
}

export async function PUT(request) {
  try {
    const input = await request.json();
    return Response.json({ config: publicDirectConfig(saveDirectConfig(input)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error?.status ? error.message : "Panel could not save direct connection settings." }, { status: error?.status || 400 });
  }
}
