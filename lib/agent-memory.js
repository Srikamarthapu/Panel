import { getMemory } from "./hermes.js";
import { getWorkAgent, listWorkAgents } from "./work-agents.js";
import { currentWorkSessionRun, getWorkSession, listWorkSessions, workSessionRunIsBusy, workSessionRunSummary } from "./work-sessions.js";
import { publicReplyText } from "./publicReply.js";

function recentConversation(session) {
  const full = getWorkSession(session.id) || session;
  const messages = (full.messages || []).filter(item => !item.isError && typeof item.text === "string").slice(-6).map(item => ({
    id: item.id,
    role: item.role === "user" ? "user" : "assistant",
    text: publicReplyText(item.text).slice(0, 2000),
    createdAt: item.createdAt || null,
  }));
  return { id: full.id, name: full.name, updatedAt: full.updatedAt, archivedAt: full.archivedAt || null, messages };
}

function activityFor(session) {
  const run = currentWorkSessionRun(session?.id);
  if (!workSessionRunIsBusy(run)) return null;
  return { ...workSessionRunSummary(run), task: typeof run.text === "string" ? run.text.replace(/\s+/g, " ").trim().slice(0, 240) : "" };
}

export function readAgentMemoryWorkspace() {
  const memory = getMemory();
  const sessions = listWorkSessions();
  const saved = listWorkAgents({ includeArchived: true });
  const mainSessions = sessions.filter(session => !session.agentId && !session.workspaceRole);
  const mainActive = mainSessions.map(session => activityFor(session)).find(Boolean) || null;
  const people = [{
    id: "main",
    kind: "main",
    name: "Main assistant",
    role: "Your primary Hermes assistant for Talk and Chat.",
    color: "sage",
    activity: mainActive,
    conversations: mainSessions.slice(0, 5).map(recentConversation),
    storage: {
      role: "Core Hermes and Panel instructions; there is no separate saved-agent SOUL.md.",
      conversations: "Panel conversation history for sessions without a saved teammate profile.",
      memory: "Shared Hermes memory is available to Hermes-mode conversations for the main assistant and saved teammates.",
    },
    capabilitySummary: "Workspace capabilities",
  }];

  for (const summary of saved) {
    const agent = getWorkAgent(summary.id);
    if (!agent) continue;
    const related = sessions.filter(session => session.agentId === agent.id).slice(0, 8);
    const policy = agent.capabilityPolicy;
    people.push({
      id: agent.id,
      kind: "saved",
      name: agent.name,
      color: agent.color,
      archivedAt: agent.archivedAt || null,
      role: agent.soul.slice(0, 20_000),
      activity: activityFor(getWorkSession(agent.sessionId)),
      conversations: related.slice(0, 5).map(recentConversation),
      storage: {
        role: `Saved in this profile's SOUL.md (${agent.soulPath}). It defines the role; it is not a separate memory database.`,
        conversations: "Panel conversation history associated with this saved profile, including earlier replacement conversations.",
        memory: "Shared Hermes memory is available to Hermes-mode conversations for the main assistant and every saved teammate.",
      },
      capabilitySummary: policy ? `${policy.tools.ids.length} tools · ${policy.skills.ids.length} skills` : "Legacy inherited access",
    });
  }

  return {
    scope: {
      title: "One shared Hermes memory",
      description: "Long-term memory and the user profile belong to the Hermes installation. Saved teammates have separate roles and conversation histories, but they do not own separate long-term memories. Direct-runtime conversations do not receive this Hermes memory.",
      source: memory.files[0]?.path ? memory.files[0].path.replace(/\/[^/]+$/, "") : "Hermes memory directory",
    },
    sharedMemory: {
      memory: memory.memory.slice(0, 80_000),
      user: memory.user.slice(0, 80_000),
      files: memory.files.map(file => ({ name: file.name, path: file.path, words: file.words, updatedAt: file.updatedAt })).slice(0, 50),
      learningEvents: memory.learningEvents.slice(0, 20),
    },
    people,
    generatedAt: new Date().toISOString(),
  };
}
