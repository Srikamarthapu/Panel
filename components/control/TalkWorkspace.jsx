"use client";
import Link from "next/link";
import { MessageSquare, SlidersHorizontal, ArrowUpRight, PanelRight } from "lucide-react";
import AgentsPane from "@/components/work/AgentsPane.jsx";
import useAgentsPane from "@/components/work/useAgentsPane.js";
import MissionOrb from "@/components/MissionOrb.jsx";
import VoiceDock from "@/components/voice/VoiceDock.jsx";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { useRuntime } from "./RuntimeProvider.jsx";
import RequestFeedback from "./RequestFeedback.jsx";
import ThinkingDetails from "./ThinkingDetails.jsx";
import { deriveTalkPresence } from "@/lib/talk-presence.js";

import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";

export default function TalkWorkspace() {
  const voice = useVoice();
  const runtime = useRuntime();
  const work = useWorkSessions();
  const [agentsOpen, showAgents] = useAgentsPane();
  const status = runtime?.status;
  const connected = runtime?.snapshot?.gateway?.online;
  const presence = deriveTalkPresence({ voiceState: voice?.state, permission: voice?.permission, runtimeStatus: status, agentRuntimeStatus: voice?.runtimeStatus, agentRuntimeError: voice?.runtimeError, connected, connectionError: Boolean(runtime?.error) });
  const { avatar, setAvatar: chooseAvatar } = useInterfacePreferences();
  return <div className="talkWithAgents" data-agents-open={agentsOpen || undefined}><section className="talkWorkspace" aria-label={`Talk with ${work?.activeAgent?.name || "Hermes"}`}>
    <header className="talkWorkspace__header"><div><h1>Talk</h1><p>{work?.activeSession ? <Link href="/sessions">{work.activeSession.name}</Link> : "A little space to think out loud"}</p></div><div className="talkWorkspace__tools"><div className="avatarSwitch" role="group" aria-label="Hermes appearance"><button type="button" aria-pressed={avatar === "orb"} onClick={() => chooseAvatar("orb")}><span>Orb</span></button><button type="button" aria-pressed={avatar === "bloub"} onClick={() => chooseAvatar("bloub")}><span>Bloub</span></button></div><Link href="/settings" className="quietLink"><SlidersHorizontal size={16} /><span>Customize</span></Link><button type="button" className="agentsToggle" aria-label="Agents" aria-expanded={agentsOpen} aria-controls="agents-pane" onClick={() => showAgents(!agentsOpen)}><PanelRight size={16} /><span>Agents</span></button></div></header>
    <div className="talkWorkspace__presence">
      {/* This slot never changes with transcript length or voice state. */}
      <div className="talkWorkspace__orb"><MissionOrb size="hero" activity={presence.avatarActivity} avatar={avatar} /></div>
      <div className="talkWorkspace__caption" aria-live="polite"><span className="presenceStatus"><span className="statusDot" data-tone={presence.active ? "online" : "muted"} />{presence.eyebrow}</span><h2>{presence.label}</h2><p>{presence.description}</p></div>
    </div>
    <footer className="talkWorkspace__footer"><div className="talkWorkspace__feedback"><ThinkingDetails /><RequestFeedback compact /></div><VoiceDock /><Link href="/chat" className="talkWorkspace__chatLink"><MessageSquare size={16} /><span>Open conversation</span><ArrowUpRight size={15} /></Link></footer>
  </section>{agentsOpen && <AgentsPane onClose={() => showAgents(false)} />}</div>;
}
