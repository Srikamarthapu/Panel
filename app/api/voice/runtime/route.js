import path from "node:path";
import { acpEnabled, warmAssistantRuntime } from "@/lib/hermes-acp-runtime";
import { getVoiceConfig } from "@/lib/voice";
import { getWorkSession, validateWorkingDirectory } from "@/lib/work-sessions";
import { getAssistantRun, getConversationSession } from "@/lib/assistant-runs";
import { dataDirectory, writeJson } from "@/lib/work-store";
import { agentForSession } from "@/lib/work-agents";
import { getDirectConfig, resolveDirectConnection } from "@/lib/direct-config";
import { resolveModelFor } from "@/lib/model-resolver.js";

export const dynamic = "force-dynamic";
export async function POST(request) {
  try {
    const input = await request.json();
    if (typeof input.sessionId !== "string" || !getWorkSession(input.sessionId)) return Response.json({ error: "Conversation not found." }, { status: 404 });
    if (input.requestId) {
      const run = getAssistantRun(input.actionId, input.sessionId);
      const permission = run?.permission;
      if (run?.state !== "active" || permission?.requestId !== input.requestId || Date.parse(permission.expiresAt) <= Date.now() || !permission.options.some(option => option.optionId === input.optionId)) return Response.json({ error: "This permission request is no longer available." }, { status: 409 });
      writeJson(path.join(dataDirectory(), "assistant-runs", `${run.id}.permission.json`), { requestId: input.requestId, optionId: input.optionId });
      return Response.json({ accepted: true });
    }
    const session = getWorkSession(input.sessionId);
    const agent = agentForSession(session);
    if (input.surface != null && !["chat", "talk"].includes(input.surface)) return Response.json({ error: "Surface must be Chat or Talk." }, { status: 400 });
    const surface = input.surface || "chat";
    const directConfig = getDirectConfig();
    const config = getVoiceConfig();
    const resolution = resolveModelFor({ surface, agent, directConfig, voiceConfig: config });
    if (directConfig.executionMode === "direct") {
      const connection = resolveDirectConnection(resolution.origin === "agent" ? { provider: resolution.requestedProvider, model: resolution.requestedModel } : {});
      return Response.json({ ready: true, enabled: true, mode: "direct", provider: connection.provider.id, model: connection.model }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!acpEnabled()) return Response.json({ ready: false, enabled: false, mode: "hermes" });
    let workingDirectory;
    try { workingDirectory = validateWorkingDirectory(session.workingDirectory); }
    catch {
      return Response.json({
        ready: false,
        code: "working_directory_unavailable",
        error: "This session's working folder is unavailable. Choose an existing folder in Session details.",
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const conversation = getConversationSession(input.sessionId);
    // Settings changes are not accepted turns. Defer a cross-mode warmup so
    // it cannot invalidate an active run or mutate native history merely
    // because the UI mounted; the first accepted Hermes turn advances the
    // generation and imports Panel's visible history.
    if (conversation.executionMode === "direct") return Response.json({ ready: true, enabled: true, deferred: true, mode: "hermes" }, { headers: { "Cache-Control": "no-store" } });
    const result = await warmAssistantRuntime({ sessionId: input.sessionId, workingDirectory, surface, provider: resolution.requestedProvider, model: resolution.requestedModel, runtimeGeneration: Math.max(1, Number(conversation.runtimeGeneration) || 1), ...(agent ? { agentId: agent.id, agentName: agent.name, agentSoul: agent.soul, ...(agent.capabilityPolicy ? { agentPolicy: agent.capabilityPolicy } : {}) } : {}), reasoningEffort: resolution.reasoningEffort });
    return Response.json({ ...result, mode: "hermes" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const direct = getDirectConfig().executionMode === "direct";
    return Response.json({ ready: false, mode: direct ? "direct" : "hermes", error: error?.status ? error.message : direct ? "Direct mode is not ready. Check its provider and model in Settings." : "Hermes could not warm up. Check its runtime and selected model before starting a request." }, { status: error?.status || 503 });
  }
}
