import { directProviderPublicMessage, directProviderPublicStatus, listDirectModels } from "@/lib/direct-provider.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const provider = new URL(request.url).searchParams.get("provider") || "";
    const models = await listDirectModels(provider);
    return Response.json({ provider, models }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: directProviderPublicMessage(error, "The provider model list could not be loaded. Check the connection and try again.") }, { status: directProviderPublicStatus(error), headers: { "Cache-Control": "no-store" } });
  }
}
