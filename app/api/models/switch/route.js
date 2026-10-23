import { MODEL_OPTIONS } from "@/lib/modelControl";
import { saveModelSelection } from "@/lib/model-catalog.js";
import { modelSwitchResponse } from "@/lib/model-switch-response.js";

export async function POST(request) {
  const input = await request.json().catch(() => ({}));
  if (!input || typeof input !== "object" || Array.isArray(input)) return Response.json({ error: "Choose a provider and model." }, { status: 400 });
  const id = String(input.id || "").trim();
  const role = String(input.role || "primary").trim();

  if (!["primary", "fallback", "voice"].includes(role)) {
    return Response.json({ error: "Role must be primary, fallback, or voice." }, { status: 400 });
  }

  try {
    if ("provider" in input || "model" in input || role === "voice") {
      return Response.json(modelSwitchResponse(await saveModelSelection({ provider: input.provider, model: input.model, role }), role));
    }
    const option = MODEL_OPTIONS.find(candidate => candidate.id === id);
    if (!option) throw new Error("Choose a model from your Hermes setup.");
    return Response.json(modelSwitchResponse(await saveModelSelection({ provider: option.provider, model: option.model, role }), role));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
