"use client";
import { useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import MissionOrb from "@/components/MissionOrb.jsx";

const states = ["working", "searching", "solving", "listening", "connecting", "weaving", "composing", "breathing", "shaping"];
export default function OrbStates() {
  const [selected, setSelected] = useState("working");
  return <details className="orbStates">
    <summary><span><strong>Orb animations</strong><small>Explore the nine original Thinking Orbs states</small></span><span aria-hidden="true">+</span></summary>
    <div className="orbStates__body"><div className="orbStates__preview"><MissionOrb size="hero" voiceState="idle" activity={{state:"working",orbState:selected,label:`Animation preview: ${selected}`}} /><strong>{selected}</strong><p>Animation preview · live workspace follows agent activity</p></div><div className="orbStates__choices">{states.map(state => <button key={state} onClick={() => setSelected(state)} aria-pressed={state === selected}><ThinkingOrb size={64} state={state} theme="dark" /><span>{state}</span></button>)}</div></div>
    <p className="orbStates__credit">Original animation engine by <a href="https://github.com/Jakubantalik/thinking-orbs" target="_blank" rel="noreferrer">Jakub Antalik</a>. Scaled at full display resolution.</p>
  </details>;
}
