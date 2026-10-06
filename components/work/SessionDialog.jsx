"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useWorkSessions } from "./WorkSessionProvider.jsx";

export default function SessionDialog({ session, agent = false, onClose, onSaved }) {
  const work = useWorkSessions();
  const dialog = useRef(null);
  const nameInput = useRef(null);
  const sending = useRef(false);
  const [name, setName] = useState(session?.name || "");
  const [directory, setDirectory] = useState(session?.workingDirectory || "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const working = Boolean(session?.activeRun);
  useEffect(() => {
    const trigger = document.activeElement;
    const modal = dialog.current;
    modal?.showModal();
    nameInput.current?.focus();
    return () => {
      modal?.close();
      if (trigger?.isConnected) trigger.focus?.();
    };
  }, []);
  async function save(event) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setPending(true); setError("");
    try {
      const input = { name: name.trim() || (agent ? "New agent" : "New session"), ...(!working ? { workingDirectory: directory.trim() || null } : {}) };
      const result = session ? await work.updateSession(session.id, input) : await work.createSession(input);
      onSaved?.(result); onClose();
    } catch (failure) { setError(failure.message); setPending(false); sending.current = false; }
  }
  return <dialog ref={dialog} className="sessionDialog" aria-labelledby="session-dialog-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header><div><h2 id="session-dialog-title">{session ? "Session details" : agent ? "New agent session" : "New session"}</h2><p>{session ? "Give this work a useful name and home." : agent ? "A separate conversation using your Hermes setup." : "Keep a conversation and its working folder together."}</p></div><button type="button" className="iconButton" aria-label="Close session details" disabled={pending} onClick={onClose}><X size={18} /></button></header>
    <form onSubmit={save} aria-busy={pending}>
      <label>Session name<input ref={nameInput} value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder={agent ? "e.g. Review the API" : "e.g. Website redesign"} /></label>
      <label>Working folder <span>Optional</span><input value={directory} disabled={working} onChange={event => setDirectory(event.target.value)} spellCheck={false} placeholder="/absolute/path/to/project" aria-describedby="session-folder-help" /></label>
      <p id="session-folder-help" className="fieldHelp">{working ? "You can change the folder after this agent finishes." : "Use an existing folder, or leave blank to use Panel’s folder."}</p>
      {error && <p className="workError" role="alert">{error}</p>}
      <footer><button type="button" className="workButton workButton--quiet" disabled={pending} onClick={onClose}>Cancel</button><button className="workButton" disabled={pending}>{pending ? "Saving…" : session ? "Save changes" : agent ? "Create agent session" : "Create session"}</button></footer>
    </form>
  </dialog>;
}
