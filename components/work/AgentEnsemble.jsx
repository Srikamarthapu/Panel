"use client";

import MissionOrb from "@/components/MissionOrb.jsx";
import { workAgentPresence } from "@/lib/work-agent-selection.js";
import styles from "./AgentEnsemble.module.css";

function SideAgent({ agent }) {
  const status = workAgentPresence(agent);
  return <figure className={styles.sideAgent} data-active={status.active || undefined}>
    <div className={styles.sideAvatar}><MissionOrb size="inline" avatar="bloub" agentName={agent.name} voiceState="idle" activity={{ state: status.state, label: status.label, isStale: false }} color={agent.color || "sage"} pointerFollowing={false} /></div>
    <figcaption><strong title={agent.name}>{agent.name}</strong><span title={status.label} role={status.active ? "status" : undefined}>{status.label}</span></figcaption>
  </figure>;
}

function MainStatus({ presence }) {
  return <div className="talkWorkspace__caption" aria-live="polite">
    <span className="presenceStatus"><span className="statusDot" data-tone={presence.active ? "online" : "muted"} />{presence.eyebrow}</span>
    <h2>{presence.label}</h2>
    <p>{presence.description}</p>
  </div>;
}

export default function AgentEnsemble({ avatar, mainName = "Hermes", presence, agents = [] }) {
  const left = agents.filter((_, index) => index % 2 === 0);
  const right = agents.filter((_, index) => index % 2 === 1);
  return <div className={`talkWorkspace__presence ${styles.ensemble}`} data-main-avatar={avatar} data-agent-count={agents.length}>
    <div className={styles.stage}>
      <div className={styles.sideColumn}>{left.map(agent => <SideAgent key={agent.id} agent={agent} />)}</div>
      <div className={styles.main}>
        <div className="talkWorkspace__orb"><MissionOrb size="hero" activity={presence.avatarActivity} avatar={avatar} agentName={mainName} /></div>
      </div>
      <div className={styles.sideColumn}>{right.map(agent => <SideAgent key={agent.id} agent={agent} />)}</div>
    </div>
    <MainStatus presence={presence} />
  </div>;
}
