"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, AudioLines, Check, Copy, Square, Pencil, Plus, PanelRight, ChevronDown } from "lucide-react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { publicReplyText } from "@/lib/publicReply.js";
import { MAX_USER_TEXT } from "@/lib/conversation-limits.js";
import MessageContent from "./MessageContent.jsx";
import RequestFeedback from "./RequestFeedback.jsx";
import ThinkingDetails from "./ThinkingDetails.jsx";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { useRuntime } from "./RuntimeProvider.jsx";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";
import SessionDialog from "@/components/work/SessionDialog.jsx";
import AgentsPane from "@/components/work/AgentsPane.jsx";

function CopyMessage({ text }) {
  const [status, setStatus] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(text); setStatus("Copied"); }
    catch { setStatus("Could not copy"); }
    timer.current = setTimeout(() => setStatus(""), 2400);
  }
  return <button type="button" className="messageCopy" aria-label={status || "Copy message"} onClick={copy}>
    {status === "Copied" ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{status || "Copy"}</span>
  </button>;
}

export default function AgentWorkspace() {
  const voice = useVoice();
  const runtime = useRuntime();
  const work = useWorkSessions();
  const [sessionDialog, setSessionDialog] = useState(null);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const { avatar } = useInterfacePreferences();
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [readingHistory, setReadingHistory] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const input = useRef(null);
  const history = useRef(null);
  const followLatest = useRef(true);
  const submitting = useRef(false);
  const busy = ["thinking", "transcribing", "speaking", "capturing"].includes(voice?.state);
  const voiceActive = !!voice?.continuousRequested || ["listening", "capturing", "speaking"].includes(voice?.state);
  const transcript = useMemo(() => (voice?.transcript || [])
    .filter(entry => ["user", "hermes", "assistant"].includes(entry?.role))
    .map(entry => ({ ...entry, text: entry.role === "user" ? entry.text : publicReplyText(entry.text) }))
    .filter(entry => entry.text), [voice?.transcript]);
  const overLimit = draft.length > MAX_USER_TEXT;
  const model = voice?.config?.voiceModel || runtime?.snapshot?.model?.model || "Primary model";
  const currentSession = work?.sessions?.find(item => item.id === work.activeSession?.id) || work?.activeSession;
  const sessions = (work?.sessions || []).filter(item => !item.archivedAt);
  useEffect(() => {
    try { setAgentsOpen(sessionStorage.getItem("panel.agents.open") === "true"); } catch { /* Optional layout preference. */ }
  }, []);
  function showAgents(open) {
    setAgentsOpen(open);
    try { sessionStorage.setItem("panel.agents.open", String(open)); } catch { /* In-memory layout still works. */ }
  }
  async function switchSession(id) {
    setSwitching(true); setSubmitError("");
    try { await work.selectSession(id); } catch (failure) { setSubmitError(failure.message); } finally { setSwitching(false); }
  }

  useEffect(() => {
    try { setDraft(sessionStorage.getItem(`panel.draft.${voice?.sessionId}`) || ""); } catch { /* storage unavailable */ }
    setReady(true);
  }, [voice?.sessionId]);
  useEffect(() => {
    if (ready) { try { sessionStorage.setItem(`panel.draft.${voice?.sessionId}`, draft); } catch { /* preserve the in-memory draft */ } }
  }, [draft, ready, voice?.sessionId]);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${Math.min(200, Math.max(40, input.current.scrollHeight))}px`;
  }, [draft]);
  const latestText = transcript.at(-1)?.text;
  useLayoutEffect(() => {
    if (history.current && followLatest.current) history.current.scrollTop = history.current.scrollHeight;
  }, [transcript.length, latestText, voice?.state, voice?.lastError, draft]);

  function scrollToLatest() {
    followLatest.current = true;
    setReadingHistory(false);
    history.current?.scrollTo({ top: history.current.scrollHeight, behavior: voice?.reduceMotion ? "instant" : "smooth" });
  }
  async function submit(event) {
    event.preventDefault();
    if (!ready || !draft.trim() || overLimit || busy || !voice || submitting.current) return;
    submitting.current = true;
    setSubmitError("");
    try {
      const accepted = await voice.sendText(draft.trim());
      if (!accepted) { setSubmitError("Your message is still here. Wait for the current request, then send again."); return; }
      setDraft("");
      followLatest.current = true;
      setReadingHistory(false);
      input.current?.focus();
    } catch { setSubmitError("Your message could not be sent. Try again."); }
    finally { submitting.current = false; }
  }

  return <div className="chatWorkspace" data-agents-open={agentsOpen || undefined}><section className="conversationPanel" aria-label="Conversation with Hermes">
    <header className="conversationHeader">
      <div className="conversationHeading">
        <div className="conversationPresence"><MissionOrb size="header" avatar={avatar} voiceState={voice?.state || "idle"} /></div>
        <div className="conversationIdentity"><h1 className="srOnly">{currentSession?.name || "Conversation"}</h1><label className="sessionPicker"><span className="srOnly">Switch session</span><select value={currentSession?.id || ""} disabled={work?.busy || switching} onChange={event => switchSession(event.target.value)}>{sessions.map(session => <option key={session.id} value={session.id}>{session.name}{session.activeRun ? " · working" : ""}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label><p>{currentSession?.workingDirectory ? currentSession.workingDirectory.split("/").filter(Boolean).at(-1) : "Hermes workspace"}{voiceActive ? " · Voice on" : ""}</p></div>
      </div>
      <div className="conversationActions">
        <button type="button" className="iconButton" aria-label="New session" title="New session" disabled={work?.busy} onClick={() => setSessionDialog("new")}><Plus size={18} /></button>
        <button type="button" className="iconButton" aria-label="Session details" title="Session details" onClick={() => setSessionDialog("edit")}><Pencil size={15} /></button>
        <Link href="/" className="iconButton chatVoiceLink" aria-label={voiceActive ? "Return to Talk" : "Talk to Hermes"} title="Voice conversation"><AudioLines size={18} /></Link>
        <button type="button" className="agentsToggle" aria-label="Agents" aria-expanded={agentsOpen} aria-controls="agents-pane" onClick={() => showAgents(!agentsOpen)}><PanelRight size={16} /><span>Agents</span>{Boolean(work?.activeRuns?.length) && <b>{work.activeRuns.length}</b>}</button>
      </div>
    </header>

    <div className="conversationScrollArea">
      <div className="conversationHistory" ref={history} role="log" aria-label="Conversation history" aria-live="polite" aria-relevant="additions text" onScroll={() => {
        const el = history.current;
        followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        setReadingHistory(!followLatest.current);
      }}>
        <div className="conversationHistory__inner">
          {transcript.length ? transcript.map((entry, index) => entry.isError ? <aside key={entry.id || index} className="conversationPastError"><span>Request interrupted</span><p>{entry.text}</p></aside> :
            <article key={entry.id || index} className="conversationMessage" data-role={entry.role}>
              <div className="conversationMessage__body"><header><strong>{entry.role === "user" ? "You" : "Hermes"}</strong>{entry.time && <time>{entry.time}</time>}<CopyMessage text={entry.text} /></header>
                {entry.role === "user" ? <p className="messageUserText">{entry.text}</p> : <MessageContent text={entry.text} />}
              </div>
            </article>) : <div className="chatWorkspace__empty"><div className="chatWorkspace__presence"><MissionOrb size="hero" avatar={avatar} voiceState="idle" /></div><h2>Where shall we start?</h2><p>Think out loud, or write it down.</p></div>}
          {voice?.state === "capturing" && <p className="chatWorkspace__hearing"><AudioLines size={16} />Listening to you…</p>}
          <ThinkingDetails />
          <RequestFeedback />
        </div>
      </div>
      {readingHistory && <button type="button" className="conversationLatest" onClick={scrollToLatest}><ArrowDown size={14} />Latest messages</button>}
    </div>

    <div className="conversationBottom">
      <form className="messageComposer" onSubmit={submit} data-busy={busy || undefined}>
        <label className="srOnly" htmlFor="hermes-message">Message Hermes</label>
        <textarea id="hermes-message" ref={input} disabled={!ready} placeholder="Message Hermes…" rows={1} value={draft} aria-describedby={overLimit ? "composer-limit" : "composer-help"} aria-invalid={overLimit || undefined} onChange={event => { setDraft(event.target.value); setSubmitError(""); }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(event); }
        }} />
        <div className="messageComposer__footer">
          <Link href="/models" title="Choose your model"><span className="statusDot" />{model}<ChevronMark /></Link>
          <div><span className="composerHint" id="composer-help">{busy ? "You can draft your next message" : <>Enter to send · Shift + Enter for a new line</>}</span>
            {busy && voice?.cancelCurrent ? <button type="button" className="sendMessage sendMessage--stop" aria-label="Stop current response" title="Stop current response" onClick={() => voice.cancelCurrent()}><Square size={15} fill="currentColor" /></button> : <button type="submit" className="sendMessage" aria-label="Send message" disabled={!ready || !draft.trim() || overLimit || busy || !voice}><ArrowUp size={19} /></button>}
          </div>
        </div>
      </form>
      <div className="conversationFooter"><span role={submitError ? "alert" : undefined}>{submitError || (overLimit ? "Shorten your message before sending." : "Saved locally")}</span>{draft.length > MAX_USER_TEXT * .8 && <span id="composer-limit" data-error={overLimit || undefined}>{draft.length.toLocaleString()} / {MAX_USER_TEXT.toLocaleString()}</span>}</div>
    </div>
  </section>{agentsOpen && <AgentsPane onClose={() => showAgents(false)} onNew={() => { showAgents(true); setSessionDialog("agent"); }} />}
    {sessionDialog && <SessionDialog session={sessionDialog === "edit" ? currentSession : null} agent={sessionDialog === "agent"} onClose={() => setSessionDialog(null)} />}
  </div>;
}

function ChevronMark() { return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>; }
