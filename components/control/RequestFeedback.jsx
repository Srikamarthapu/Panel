"use client";

import Link from "next/link";
import { AlertCircle, RotateCcw } from "lucide-react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";

export default function RequestFeedback({ compact = false }) {
  const voice = useVoice();
  const error = voice?.lastError;
  if (!error) return null;
  const title = { stt: "Couldn't hear that", chat: "Request interrupted", tts: "Audio couldn't play", permission: "Microphone needs access", microphone: "Microphone needs attention" }[error.stage] || "Something interrupted the request";
  return <aside className={`requestFeedback${compact ? " requestFeedback--compact" : ""}`} role="alert">
    <AlertCircle size={18} /><div><strong>{title}</strong><p>{error.message || "Please try again."}</p></div>
    <div className="requestFeedback__actions">{voice.canRetry && voice.retryLastRequest && <button type="button" onClick={() => voice.retryLastRequest()}><RotateCcw size={14} />Try again</button>}{["stt", "tts", "permission", "microphone"].includes(error.stage) && <Link href="/voice">Voice settings</Link>}</div>
  </aside>;
}
