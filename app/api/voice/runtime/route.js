import path from "node:path";
import { acpEnabled, warmAssistantRuntime } from "@/lib/hermes-acp-runtime";
import { getVoiceConfig } from "@/lib/voice";
import { getWorkSession, validateWorkingDirectory } from "@/lib/work-sessions";
import { getAssistantRun } from "@/lib/assistant-runs";
import { dataDirectory, writeJson } from "@/lib/work-store";
import { agentForSession } from "@/lib/work-agents";

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
    if (!acpEnabled()) return Response.json({ ready: false, enabled: false });
    const session = getWorkSession(input.sessionId);
    let workingDirectory;
    try { workingDirectory = validateWorkingDirectory(session.workingDirectory); }
    catch {
      return Response.json({
        ready: false,
        code: "working_directory_unavailable",
        error: "This session's working folder is unavailable. Choose an existing folder in Session details.",
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const config = getVoiceConfig();
    const agent = agentForSession(session);
    const result = await warmAssistantRuntime({ sessionId: input.sessionId, workingDirectory, provider: agent?.provider || config.voiceModelProvider || "", model: agent?.model || config.voiceModel || "", ...(agent ? { agentId: agent.id, agentName: agent.name, agentSoul: agent.soul } : {}), reasoningEffort: config.voiceReasoningEffort || "" });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ ready: false, error: "Hermes could not warm up. Check its runtime and selected model before starting a request." }, { status: 503 }); }
}
