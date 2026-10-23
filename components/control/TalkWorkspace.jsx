"use client";
import Link from "next/link";
import { MessageSquare, SlidersHorizontal, PanelRight, Repeat2 } from "lucide-react";
import AgentsPane from "@/components/work/AgentsPane.jsx";
import useAgentsPane from "@/components/work/useAgentsPane.js";
import AgentEnsemble from "@/components/work/AgentEnsemble.jsx";
import VoiceDock, { useTalkVoiceControls } from "@/components/voice/VoiceDock.jsx";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { useRuntime } from "./RuntimeProvider.jsx";
import RequestFeedback from "./RequestFeedback.jsx";
import ThinkingDetails from "./ThinkingDetails.jsx";
import { deriveTalkPresence } from "@/lib/talk-presence.js";

import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";
import ModelChip from "./ModelChip.jsx";

export default function TalkWorkspace() {
  const voice = useVoice();
  const runtime = useRuntime();
  const work = useWorkSessions();
  const voiceControls = useTalkVoiceControls();
  const [agentsOpen, showAgents] = useAgentsPane();
  const status = runtime?.status;
  const connected = runtime?.snapshot?.gateway?.online;
  const presence = deriveTalkPresence({ voiceState: voice?.state, permission: voice?.permission, runtimeStatus: status, agentRuntimeStatus: voice?.runtimeStatus, agentRuntimeError: voice?.runtimeError, connected, connectionError: Boolean(runtime?.error) });
  const directMode = work?.directConfig?.executionMode === "direct";
  const assistantName = work?.activeAgent?.name || (directMode ? "Direct assistant" : "Hermes");
  const displayedPresence = directMode && presence.state === "idle" ? { ...presence, eyebrow: "DIRECT API READY", description: `${work.directConfig.provider} · ${work.directConfig.model}` } : presence;
  const { avatar, setAvatar: chooseAvatar } = useInterfacePreferences();
  const nextMode = voiceControls.mode === "ptt" ? "Conversation" : "Push to talk";
  return <div className="talkWithAgents" data-agents-open={agentsOpen || undefined}><section className="talkWorkspace" aria-label={`Talk with ${assistantName}`}>
    <header className="talkWorkspace__header"><div><h1>Talk</h1><p>{work?.activeSession ? <Link href="/sessions">{work.activeSession.name}</Link> : "A little space to think out loud"}</p></div><div className="talkWorkspace__tools">
      <button type="button" className="talkWorkspace__mode" data-talk-voice-control="mode" aria-label={`Voice mode: ${voiceControls.modeLabel}. Switch to ${nextMode}. Shortcut Shift V`} onClick={voiceControls.cycleMode}><Repeat2 size={14} aria-hidden="true" /><span>{voiceControls.modeLabel}</span><kbd>⇧V</kbd></button>
      <Link href="/chat" className="talkWorkspace__chatLink"><MessageSquare size={15} aria-hidden="true" /><span>Chat</span></Link>
      <div className="avatarSwitch" role="group" aria-label={`${assistantName} appearance`}><button type="button" aria-pressed={avatar === "orb"} onClick={() => chooseAvatar("orb")}><span>Orb</span></button><button type="button" aria-pressed={avatar === "bloub"} onClick={() => chooseAvatar("bloub")}><span>Bloub</span></button></div><Link href="/settings" className="quietLink"><SlidersHorizontal size={16} aria-hidden="true" /><span>Customize</span></Link><button type="button" className="agentsToggle" aria-label="Agents" aria-expanded={agentsOpen} aria-controls="agents-pane" onClick={() => showAgents(!agentsOpen)}><PanelRight size={16} aria-hidden="true" /><span>Agents</span></button></div></header>
    <VoiceDock controller={voiceControls} stage>{({ mainControl, instructionId }) => <>
      <AgentEnsemble avatar={avatar} mainName={assistantName} presence={displayedPresence} agents={work?.selectedAgents || []} mainControl={{ ...mainControl, description: displayedPresence.state === "idle" ? mainControl.description : null }} instructionId={instructionId} modelCaption={<ModelChip surface="talk" compact />} />
      <div className="talkWorkspace__feedback"><ThinkingDetails /><RequestFeedback compact /></div>
    </>}</VoiceDock>
  </section>{agentsOpen && <AgentsPane onClose={() => showAgents(false)} />}</div>;
}
