"use client";

import { useEffect, useRef, useState } from "react";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { AVATAR_PALETTES } from "@/lib/interface-preferences.js";
import { workAgentPresence } from "@/lib/work-agent-selection.js";
import styles from "./AgentEnsemble.module.css";

function SideAgent({ agent, order, glow }) {
  const status = workAgentPresence(agent);
  const color = AVATAR_PALETTES[agent.color]?.color || AVATAR_PALETTES.sage.color;
  const side = order % 2 === 0 ? "left" : "right";
  return <figure className={styles.sideAgent} data-side={side} data-active={status.active || undefined} data-companion-glow={glow || undefined} style={{ "--companion-order": order, "--companion-row": Math.floor(order / 2) + 1, "--companion-glow-color": color }}>
    <div className={styles.sideAvatar}><MissionOrb size="inline" avatar="bloub" agentName={agent.name} voiceState="idle" activity={{ state: status.state, label: status.label, isStale: false }} color={agent.color || "sage"} pointerFollowing={false} preserveBloubBody /></div>
    <figcaption><strong title={agent.name}>{agent.name}</strong><span title={status.label} role={status.active ? "status" : undefined}>{status.label}</span></figcaption>
  </figure>;
}

function MainStatus({ presence, instruction, instructionId, modelCaption }) {
  return <div className="talkWorkspace__caption" aria-live="polite">
    <span className="presenceStatus"><span className="statusDot" data-tone={presence.active ? "online" : "muted"} />{presence.eyebrow}</span>
    <h2>{presence.label}</h2>
    <p id={instructionId}>{instruction || presence.description}</p>
    {modelCaption}
  </div>;
}

export default function AgentEnsemble({ avatar, mainName = "Hermes", presence, agents = [], mainControl = null, instructionId, modelCaption = null }) {
  const stageRef = useRef(null);
  const [stageVisible, setStageVisible] = useState(false);
  const { preferences, reducedMotion } = useInterfacePreferences();
  const floatEnabled = preferences.companionFloat && !reducedMotion;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const canObserve = typeof IntersectionObserver !== "undefined";
    let inView = !canObserve;
    const sync = () => setStageVisible(inView && document.visibilityState !== "hidden");
    const observer = canObserve ? new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }) : null;
    observer?.observe(stage);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => { observer?.disconnect(); document.removeEventListener("visibilitychange", sync); };
  }, []);

  return <div className={`talkWorkspace__presence ${styles.ensemble}`} data-main-avatar={avatar} data-agent-count={agents.length} data-companion-float={floatEnabled || undefined} data-motion-active={floatEnabled && stageVisible || undefined}>
    <div className={styles.stage} ref={stageRef}>
      <div className={styles.main}>
        {mainControl ? <button
          type="button"
          className={`talkWorkspace__orb ${styles.mainControl} voiceDock__hold${mainControl.active ? ` ${styles.mainControlActive} is-active` : ""}${mainControl.stopResponse ? ` ${styles.mainControlStop}` : ""}`}
          aria-label={`${mainControl.label} with ${mainName}`}
          aria-describedby={instructionId}
          aria-pressed={mainControl.pressed}
          data-talk-voice-control="primary"
          onClick={mainControl.onClick}
          onPointerDown={mainControl.onPointerDown}
          onPointerUp={mainControl.onPointerUp}
          onPointerCancel={mainControl.onPointerCancel}
          onLostPointerCapture={mainControl.onLostPointerCapture}
          onBlur={mainControl.onBlur}
          onKeyDown={mainControl.onKeyDown}
          onKeyUp={mainControl.onKeyUp}
        >
          <MissionOrb size="hero" activity={presence.avatarActivity} avatar={avatar} agentName={mainName} />
          <span className={styles.mainAction} data-stop={mainControl.stopResponse || undefined}>{mainControl.label}</span>
        </button> : <div className="talkWorkspace__orb"><MissionOrb size="hero" activity={presence.avatarActivity} avatar={avatar} agentName={mainName} /></div>}
      </div>
      <div className={styles.companions}>{agents.map((agent, index) => <SideAgent key={agent.id} agent={agent} order={index} glow={preferences.companionGlow} />)}</div>
    </div>
    <MainStatus presence={presence} instruction={mainControl?.description} instructionId={instructionId} modelCaption={modelCaption} />
  </div>;
}
