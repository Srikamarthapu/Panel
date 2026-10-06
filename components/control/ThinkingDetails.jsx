"use client";
import { Check, ChevronDown, Circle, CircleAlert } from "lucide-react";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { useRuntime } from "./RuntimeProvider.jsx";
import useAvatarPreference from "./useAvatarPreference.js";
import { eventTimestamp } from "@/lib/control-center-status.js";

function toolLabel(event) {
  if (event.source === "hermes/jev") {
    if (event.title === "Jev kept useful tool context") return "Jev kept useful tool context";
    if (event.title === "Hermes kept the original context") return "Jev left the original context unchanged";
    if (event.title === "Jev selected a ready action") return "Jev selected a ready action";
    if (event.title === "Jev selected the next tool") return "Jev selected the next tool";
    if (event.title === "Jev finished tool routing") return "Jev finished tool routing";
    if (event.title === "Jev deferred to Hermes") return "Jev deferred this step to Hermes";
    if (event.title === "Jev detected a repeated approach") return "Jev checked repeated attempts";
    return "Jev evaluated the next step";
  }
  const name = String(event.toolName || event.target || "").toLowerCase();
  if (/search|browse|web|fetch/.test(name)) return "Looking up information";
  if (/read|file|memory/.test(name)) return "Reading context";
  if (/write|edit|patch/.test(name)) return "Making changes";
  if (/terminal|shell|exec|command/.test(name)) return "Running a command";
  if (/agent|delegate/.test(name)) return "Working with an agent";
  if (/skill/.test(name)) return "Preparing the right tools";
  if (event.source === "voice/action" || event.source === "hermes/task") return "Working on your request";
  if (event.source === "voice/data") return "Checking your information";
  return "Using a tool";
}
export default function ThinkingDetails() {
  const runtime = useRuntime();
  const voice = useVoice();
  const [avatar] = useAvatarPreference();
  const active = ["thinking", "transcribing"].includes(voice?.state);
  const now = runtime?.now || Date.now();
  const recent = (runtime?.snapshot?.activity || []).filter(event => {
    if (event.kind !== "tool" && !["voice/action", "voice/data", "hermes/task"].includes(event.source)) return false;
    if (event.sessionId && event.sessionId !== voice?.sessionId) return false;
    const matchesSession = event.sessionId && event.sessionId === voice?.sessionId;
    const matchesRun = event.runId && voice?.actionId && event.runId === voice.actionId;
    if (!matchesSession && !matchesRun) return false;
    if (voice?.actionId && event.runId && event.runId !== voice.actionId) return false;
    const ts = eventTimestamp(event);
    return ts !== null && ts <= now + 5000 && now - ts < 10 * 60 * 1000 && (!voice?.requestStartedAt || ts >= voice.requestStartedAt - 2000);
  }).sort((a, b) => eventTimestamp(b) - eventTimestamp(a));
  const unique = new Map();
  for (const event of recent) {
    const id = event.callId || event.runId || String(event.id || "").replace(/:(running|complete|failed)$/, "") || `${event.source}:${event.toolName}`;
    if (!unique.has(id)) unique.set(id, event);
  }
  const events = [...unique.values()].slice(0, 8);
  const hasFailure = events.some(event => ["error", "failed", "cancelled"].includes(event.state));
  const elapsed = voice?.requestStartedAt ? Math.max(0, Math.floor((now - voice.requestStartedAt) / 1000)) : 0;
  const phase = voice?.state === "transcribing" ? "Understanding your voice" : voice?.activeRequestStatus || (events.some(event => ["queued", "active", "running"].includes(event.state)) ? "Working with tools" : "Thinking");
  if (!active && !events.length) return null;
  return <details className="thinkingDetails" data-active={active || undefined}><summary>{active ? <MissionOrb size="inline" avatar={avatar} activity={runtime?.status} /> : hasFailure ? <CircleAlert size={15} /> : <Check size={15} />}<span>{active ? phase : "Activity"}</span><small>{active && elapsed >= 3 ? `${elapsed}s` : events.length ? `${events.length} ${events.length === 1 ? "step" : "steps"}` : ""}</small><ChevronDown size={14} /></summary><div>{events.length ? <ol>{events.map((event,index) => {
    const done = ["completed", "complete", "done"].includes(event.state);
    const failed = ["error", "failed", "cancelled"].includes(event.state);
    const Icon = failed ? CircleAlert : done ? Check : Circle;
    return <li key={event.id || index}><Icon size={13} /><span>{toolLabel(event)}</span><small>{done ? event.source === "hermes/jev" ? "Evaluated" : "Done" : event.state === "cancelled" ? "Stopped" : failed ? "Needs attention" : active ? "In progress" : "No recent update"}</small></li>;
  })}</ol> : <p>{voice?.state === "transcribing" ? "Turning your speech into a message." : voice?.activeRequestStatus || "Hermes is preparing a reply. Tool activity appears here when needed."}</p>}{active && elapsed > 20 && <p className="thinkingDetails__wait">This is taking longer than usual. You can stop the request below.</p>}</div></details>;
}
