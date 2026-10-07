"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertCircle, RotateCcw, Shield } from "lucide-react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";

function ActionPermission({ permission, respond, compact }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const choose = async (optionId) => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try { await respond(optionId); }
    catch (failure) { setError(failure?.message || "Could not send your choice. Try again."); }
    finally { setSubmitting(false); }
  };
  return <aside className={`requestFeedback${compact ? " requestFeedback--compact" : ""}`} role="alert" aria-label="Action permission">
    <Shield size={18} />
    <div><strong>{permission.title || "Hermes needs your permission"}</strong>{permission.description && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{permission.description}</p>}{error && <p>{error}</p>}</div>
    <div className="requestFeedback__actions">{(permission.options || []).map(option => <button key={option.optionId} type="button" disabled={submitting} onClick={() => choose(option.optionId)}>{option.name}</button>)}</div>
  </aside>;
}

export default function RequestFeedback({ compact = false }) {
  const voice = useVoice();
  if (voice?.pendingPermission && voice.respondToPermission) return <ActionPermission key={voice.pendingPermission.requestId} permission={voice.pendingPermission} respond={voice.respondToPermission} compact={compact} />;
  const error = voice?.lastError;
  if (!error) return null;
  const title = { stt: "Couldn't hear that", chat: "Request interrupted", tts: "Audio couldn't play", permission: "Microphone needs access", microphone: "Microphone needs attention" }[error.stage] || "Something interrupted the request";
  return <aside className={`requestFeedback${compact ? " requestFeedback--compact" : ""}`} role="alert">
    <AlertCircle size={18} /><div><strong>{title}</strong><p>{error.message || "Please try again."}</p></div>
    <div className="requestFeedback__actions">{voice.canRetry && voice.retryLastRequest && <button type="button" onClick={() => voice.retryLastRequest()}><RotateCcw size={14} />Try again</button>}{["stt", "tts", "permission", "microphone"].includes(error.stage) && <Link href="/voice">Voice settings</Link>}</div>
  </aside>;
}
