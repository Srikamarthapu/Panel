import { getModelCatalog } from "@/lib/model-catalog.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const query = new URL(request.url).searchParams;
  try {
    return Response.json(await getModelCatalog({ refresh: query.get("refresh") === "1", provider: query.get("provider") || "" }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 503 });
  }
}
