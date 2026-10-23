"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, AudioLines, Check, Copy, Square, Pencil, Plus, PanelRight, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import { publicReplyText } from "@/lib/publicReply.js";
import { MAX_USER_TEXT } from "@/lib/conversation-limits.js";
import MessageContent from "./MessageContent.jsx";
import RequestFeedback from "./RequestFeedback.jsx";
import ThinkingDetails from "./ThinkingDetails.jsx";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";
import SessionDialog from "@/components/work/SessionDialog.jsx";
import AgentsPane from "@/components/work/AgentsPane.jsx";
import AgentProfileDialog from "@/components/work/AgentProfileDialog.jsx";
import useAgentsPane from "@/components/work/useAgentsPane.js";
import OutcomeReview from "@/components/work/OutcomeReview.jsx";
import { shouldShowChatOutcome } from "@/lib/chat-outcome.js";
import ModelChip from "./ModelChip.jsx";

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
  const work = useWorkSessions();
  const [sessionDialog, setSessionDialog] = useState(null);
  const [agentsOpen, showAgents] = useAgentsPane();
  const [switching, setSwitching] = useState(false);
  const { avatar } = useInterfacePreferences();
  const [draftState, setDraftState] = useState({ sessionId: "", text: "" });
  const [readingHistory, setReadingHistory] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [submitError, setSubmitError] = useState("");
  const input = useRef(null);
  const searchInput = useRef(null);
  const searchButton = useRef(null);
  const history = useRef(null);
  const followLatest = useRef(true);
  const submitting = useRef(false);
  const busy = ["thinking", "transcribing", "speaking", "capturing"].includes(voice?.state);
  const voiceActive = !!voice?.continuousRequested || ["listening", "capturing", "speaking"].includes(voice?.state);
  const transcript = useMemo(() => (voice?.transcript || [])
    .filter(entry => ["user", "hermes", "assistant"].includes(entry?.role))
    .map(entry => ({ ...entry, text: entry.role === "user" ? entry.text : publicReplyText(entry.text) }))
    .filter(entry => entry.text), [voice?.transcript]);
  const draftSessionId = voice?.sessionId || "";
  const ready = Boolean(draftSessionId && draftState.sessionId === draftSessionId);
  const draft = ready ? draftState.text : "";
  const overLimit = draft.length > MAX_USER_TEXT;
  const setDraft = value => setDraftState(current => ({ sessionId: draftSessionId, text: typeof value === "function" ? value(current.sessionId === draftSessionId ? current.text : "") : value }));
  const directMode = work?.directConfig?.executionMode === "direct";
  const agentName = work?.activeAgent?.name || (directMode ? "Direct assistant" : "Hermes");
  const currentSession = work?.sessions?.find(item => item.id === work.activeSession?.id) || work?.activeSession;
  const conversationContext = directMode ? `Direct · ${work.directConfig.provider}` : currentSession?.workingDirectory ? currentSession.workingDirectory.split("/").filter(Boolean).at(-1) : "Hermes workspace";
  const sessions = (work?.sessions || []).filter(item => !item.archivedAt);
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const searchMatches = useMemo(() => normalizedSearch ? transcript.flatMap((entry, index) => entry.text.toLocaleLowerCase().includes(normalizedSearch) ? [index] : []) : [], [transcript, normalizedSearch]);
  const currentSearchIndex = searchMatches.length ? Math.min(searchIndex, searchMatches.length - 1) : 0;
  async function switchSession(id) {
    setSwitching(true); setSubmitError("");
    try { await work.selectSession(id); } catch (failure) { setSubmitError(failure.message); } finally { setSwitching(false); }
  }

  useEffect(() => {
    let text = "";
    try { text = sessionStorage.getItem(`panel.draft.${draftSessionId}`) || ""; } catch { /* storage unavailable */ }
    setDraftState({ sessionId: draftSessionId, text });
  }, [draftSessionId]);
  useEffect(() => {
    if (draftState.sessionId) { try { sessionStorage.setItem(`panel.draft.${draftState.sessionId}`, draftState.text); } catch { /* preserve the in-memory draft */ } }
  }, [draftState]);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${Math.min(200, Math.max(40, input.current.scrollHeight))}px`;
  }, [draft]);
  const latestText = transcript.at(-1)?.text;
  useLayoutEffect(() => {
    if (history.current && followLatest.current) history.current.scrollTop = history.current.scrollHeight;
  }, [transcript.length, latestText, voice?.state, voice?.lastError, draft]);
  useLayoutEffect(() => {
    followLatest.current = true;
    setReadingHistory(false);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [draftSessionId]);

  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useLayoutEffect(() => {
    if (!searchOpen || !normalizedSearch || !searchMatches.length) return;
    followLatest.current = false;
    setReadingHistory(true);
    history.current?.querySelector(`[data-message-index="${searchMatches[currentSearchIndex]}"]`)?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [searchOpen, normalizedSearch, searchMatches, currentSearchIndex]);

  function openSearch() {
    followLatest.current = false;
    setReadingHistory(true);
    setSearchOpen(true);
  }
  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
    searchButton.current?.focus();
  }
  function moveSearch(direction) {
    if (!searchMatches.length) return;
    setSearchIndex(current => (Math.min(current, searchMatches.length - 1) + direction + searchMatches.length) % searchMatches.length);
  }

  function scrollToLatest() {
    followLatest.current = true;
    setReadingHistory(false);
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
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

  return <div className="chatWorkspace" data-agents-open={agentsOpen || undefined}><section className="conversationPanel" aria-label={`Conversation with ${agentName}`} data-search-open={searchOpen || undefined}>
    <header className="conversationHeader">
      <div className="conversationHeading">
        <div className="conversationPresence"><MissionOrb size="header" avatar={avatar} voiceState={voice?.state || "idle"} /></div>
        <div className="conversationIdentity"><h1 className="srOnly">{currentSession?.name || "Conversation"}</h1><label className="sessionPicker"><span className="srOnly">Switch session</span><select value={currentSession?.id || ""} disabled={work?.busy || switching} onChange={event => switchSession(event.target.value)}>{sessions.map(session => <option key={session.id} value={session.id}>{session.name}{session.activeRun ? " · working" : ""}</option>)}</select><ChevronDown size={13} aria-hidden="true" /></label><p>{conversationContext}{voiceActive ? " · Voice on" : ""}</p></div>
      </div>
      <div className="conversationActions">
        {transcript.length >= 6 && <button ref={searchButton} type="button" className="iconButton" aria-label="Search conversation" aria-expanded={searchOpen} aria-controls="conversation-search" onClick={() => searchOpen ? closeSearch() : openSearch()}><Search size={16} /></button>}
        <button type="button" className="iconButton" aria-label="New session" title="New session" disabled={work?.busy} onClick={event => { event.currentTarget.focus(); setSessionDialog("new"); }}><Plus size={18} /></button>
        <button type="button" className="iconButton" aria-label="Session details" title="Session details" onClick={event => { event.currentTarget.focus(); setSessionDialog("edit"); }}><Pencil size={15} /></button>
        <Link href="/" className="iconButton chatVoiceLink" aria-label={voiceActive ? "Return to Talk" : `Talk to ${agentName}`} title="Voice conversation"><AudioLines size={18} /></Link>
        <button type="button" className="agentsToggle" aria-label="Agents" aria-expanded={agentsOpen} aria-controls="agents-pane" onClick={() => showAgents(!agentsOpen)}><PanelRight size={16} /><span>Agents</span>{Boolean(work?.activeRuns?.length) && <b>{work.activeRuns.length}</b>}</button>
      </div>
    </header>

    {searchOpen && <form id="conversation-search" className="conversationSearch" role="search" onSubmit={event => { event.preventDefault(); moveSearch(1); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); closeSearch(); } }}>
      <Search size={15} aria-hidden="true" />
      <label className="srOnly" htmlFor="conversation-search-input">Search this conversation</label>
      <input id="conversation-search-input" ref={searchInput} type="search" value={searchQuery} placeholder="Search this conversation" autoComplete="off" onChange={event => { setSearchQuery(event.target.value); setSearchIndex(0); }} />
      <span className="conversationSearch__count" role="status" aria-live="polite">{normalizedSearch ? searchMatches.length ? `${currentSearchIndex + 1} of ${searchMatches.length}` : "No matches" : "Type to search"}</span>
      <button type="button" aria-label="Previous match" disabled={!searchMatches.length} onClick={() => moveSearch(-1)}><ChevronUp size={15} /></button>
      <button type="submit" aria-label="Next match" disabled={!searchMatches.length}><ChevronDown size={15} /></button>
      <button type="button" aria-label="Close conversation search" onClick={closeSearch}><X size={15} /></button>
    </form>}

    <div className="conversationScrollArea">
      <div className="conversationHistory" ref={history} role="log" aria-label="Conversation history" aria-live="polite" aria-relevant="additions text" onScroll={() => {
        const el = history.current;
        followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        setReadingHistory(!followLatest.current);
      }}>
        <div className="conversationHistory__inner">
          {transcript.length ? transcript.map((entry, index) => entry.isError ? <div key={entry.id || index} className="conversationOutcome" data-message-index={index}><aside className="conversationPastError"><span>Request interrupted</span><p>{entry.text}</p></aside><OutcomeReview outcome={entry.outcome} showSummary={false} /></div> :
            <article key={entry.id || index} className="conversationMessage" data-role={entry.role} data-message-index={index} data-search-match={searchOpen && searchMatches[currentSearchIndex] === index || undefined}>
              <div className="conversationMessage__body"><header><strong>{entry.role === "user" ? "You" : agentName}</strong>{entry.partialResponse && <span className="conversationMessage__status">Partial response · request interrupted</span>}{entry.time && <time>{entry.time}</time>}{entry.role !== "user" && <CopyMessage text={entry.text} />}</header>
                {entry.role === "user" ? <p className="messageUserText">{entry.text}</p> : <MessageContent text={entry.text} />}
                {entry.role !== "user" && shouldShowChatOutcome(entry.outcome) && <OutcomeReview outcome={entry.outcome} showSummary={false} />}
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
        <label className="srOnly" htmlFor="assistant-message">Message {agentName}</label>
        <textarea id="assistant-message" ref={input} disabled={!ready} placeholder={`Message ${agentName}…`} rows={1} value={draft} aria-describedby={overLimit ? "composer-limit" : "composer-help"} aria-invalid={overLimit || undefined} onChange={event => { setDraft(event.target.value); setSubmitError(""); }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(event); }
        }} />
        <div className="messageComposer__footer">
          <ModelChip surface="chat" />
          <div><span className="composerHint" id="composer-help">{busy ? "You can draft your next message" : <>Enter to send · Shift + Enter for a new line</>}</span>
            {busy && voice?.cancelCurrent ? <button type="button" className="sendMessage sendMessage--stop" aria-label="Stop current response" title="Stop current response" onClick={() => voice.cancelCurrent()}><Square size={15} fill="currentColor" /></button> : <button type="submit" className="sendMessage" aria-label="Send message" disabled={!ready || !draft.trim() || overLimit || busy || !voice}><ArrowUp size={19} /></button>}
          </div>
        </div>
      </form>
      <div className="conversationFooter"><span role={submitError ? "alert" : undefined}>{submitError || (overLimit ? "Shorten your message before sending." : "Saved locally")}</span>{draft.length > MAX_USER_TEXT * .8 && <span id="composer-limit" data-error={overLimit || undefined}>{draft.length.toLocaleString()} / {MAX_USER_TEXT.toLocaleString()}</span>}</div>
    </div>
  </section>{agentsOpen && <AgentsPane onClose={() => showAgents(false)} />}
    {sessionDialog === "edit" && work?.activeAgent ? <AgentProfileDialog agent={work.activeAgent} onClose={() => setSessionDialog(null)} /> : sessionDialog && <SessionDialog session={sessionDialog === "edit" ? currentSession : null} onClose={() => setSessionDialog(null)} />}
  </div>;
}
