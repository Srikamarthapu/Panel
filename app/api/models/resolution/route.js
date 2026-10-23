import { getDirectConfig } from "@/lib/direct-config.js";
import { getModelCatalog, validateModelSelection } from "@/lib/model-catalog.js";
import { resolveModelFor } from "@/lib/model-resolver.js";
import { agentForSession } from "@/lib/work-agents.js";
import { getVoiceConfig, saveSurfaceModelPreference } from "@/lib/voice.js";
import { getWorkSession } from "@/lib/work-sessions.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function selectedSurface(value) {
  if (value !== "chat" && value !== "talk") throw Object.assign(new Error("Choose Chat or Talk."), { status: 400 });
  return value;
}

function selectedSession(value) {
  if (!value) return null;
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw Object.assign(new Error("Invalid session ID."), { status: 400 });
  const session = getWorkSession(value);
  if (!session) throw Object.assign(new Error("Session not found."), { status: 404 });
  return session;
}

function payload(surface, session = null) {
  const voiceConfig = getVoiceConfig();
  return {
    resolution: resolveModelFor({ surface, agent: session ? agentForSession(session) : null, voiceConfig }),
    preferences: voiceConfig.modelPreferences,
  };
}

export function GET(request) {
  try {
    const query = new URL(request.url).searchParams;
    const surface = selectedSurface(query.get("surface"));
    const session = selectedSession(query.get("sessionId"));
    return Response.json(payload(surface, session), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Panel could not resolve this model." }, { status: error.status || 500 });
  }
}

export async function PATCH(request) {
  try {
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("Model settings are required."), { status: 400 });
    const surface = selectedSurface(input.surface);
    const session = selectedSession(input.sessionId);
    if (getDirectConfig().executionMode === "direct") {
      throw Object.assign(new Error("Chat and Talk use the saved Direct API connection in direct mode. Change that model in Settings."), { status: 409 });
    }
    if (input.mode === "pin") {
      const catalog = await getModelCatalog();
      if (catalog.degraded) throw Object.assign(new Error(catalog.warning || "Hermes model setup is read-only."), { status: 409 });
      validateModelSelection(catalog, { provider: input.provider, model: input.model, role: "primary" });
    }
    saveSurfaceModelPreference(surface, { mode: input.mode, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort });
    return Response.json(payload(surface, session), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Panel could not save this model preference." }, { status: error.status || 400 });
  }
}
