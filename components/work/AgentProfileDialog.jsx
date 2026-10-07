"use client";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useWorkSessions, workRequest } from "./WorkSessionProvider.jsx";
import useModelCatalog from "@/components/control/useModelCatalog.js";

export default function AgentProfileDialog({ agent, onClose }) {
  const work = useWorkSessions();
  const dialog = useRef(null), first = useRef(null), sending = useRef(false), id = useRef(null);
  const [form, setForm] = useState({ name: agent?.name || "", soul: "", workingDirectory: agent?.workingDirectory || "", provider: agent?.provider || "", model: agent?.model || "" });
  const [loading, setLoading] = useState(Boolean(agent)), [pending, setPending] = useState(false), [error, setError] = useState("");
  const { catalog } = useModelCatalog();
  useEffect(() => {
    const trigger = document.activeElement, modal = dialog.current;
    id.current = crypto.randomUUID(); modal.showModal(); first.current?.focus();
    return () => { modal.close(); if (trigger?.isConnected) trigger.focus?.(); };
  }, []);
  useEffect(() => {
    if (!agent) return;
    const controller = new AbortController();
    workRequest(`/api/agents/${agent.id}`, { signal: controller.signal }).then(data => {
      setForm({ name: data.agent.name, soul: data.agent.soul, workingDirectory: data.agent.workingDirectory, provider: data.agent.provider, model: data.agent.model }); setLoading(false);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [agent]);
  function field(key) { return { value: form[key], onChange: event => setForm(previous => ({ ...previous, [key]: event.target.value })) }; }
  async function save(event) {
    event.preventDefault(); if (sending.current || loading) return;
    sending.current = true; setPending(true); setError("");
    try { await work.saveAgent({ ...form, ...(!agent ? { id: id.current } : {}), workingDirectory: form.workingDirectory.trim() || null }, agent?.id); onClose(); }
    catch (failure) { setError(failure.message); sending.current = false; setPending(false); }
  }
  return <dialog ref={dialog} className="sessionDialog agentProfileDialog" aria-labelledby="agent-profile-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header><div><h2 id="agent-profile-title">{agent ? "Agent profile" : "New agent"}</h2><p>A persistent teammate with its own instructions, workspace, and conversation.</p></div><button type="button" className="iconButton" aria-label="Close agent profile" disabled={pending} onClick={onClose}><X size={18} /></button></header>
    <form onSubmit={save} aria-busy={pending || loading}><fieldset disabled={pending || loading}>
      <label>Agent name<input ref={first} {...field("name")} required maxLength={120} placeholder="e.g. Researcher" autoComplete="off" /></label>
      <label>SOUL.md<textarea {...field("soul")} rows={7} maxLength={20000} spellCheck={false} placeholder="Describe this agent’s role, working style, and responsibilities." aria-describedby="agent-soul-help" /></label>
      <p className="fieldHelp" id="agent-soul-help">Saved as a real SOUL.md file. Give this agent a clear specialty so Hermes can choose it for the right work.</p>
      <label>Working folder <span>Optional</span><input {...field("workingDirectory")} spellCheck={false} placeholder="Leave blank for a separate agent workspace" aria-describedby="agent-folder-help" /></label>
      <p className="fieldHelp" id="agent-folder-help">An existing absolute path, or a new private folder managed by Panel. Workspace separation is not a tool sandbox.</p>
      <div className="agentProfileDialog__models"><label>Provider<input {...field("provider")} list="agent-providers" placeholder="Workspace default" autoComplete="off" spellCheck={false} /></label><label>Model ID<input {...field("model")} list="agent-models" placeholder="Workspace default" autoComplete="off" spellCheck={false} /></label></div>
      <datalist id="agent-providers">{(catalog?.providers || []).filter(p => p.configured).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</datalist>
      <datalist id="agent-models">{(catalog?.providers || []).filter(p => p.id === form.provider).flatMap(p => p.models || []).map(m => <option key={typeof m === "string" ? m : m.id} value={typeof m === "string" ? m : m.id} />)}</datalist>
      <p className="fieldHelp">Set both to use a connected model, or leave both blank to follow your Talk &amp; Chat model. Credentials stay in your Hermes setup.</p>
    </fieldset>{loading && !error && <p role="status" className="fieldHelp">Loading profile…</p>}{error && <p role="alert" className="workError">{error}</p>}
      <footer><button type="button" className="workButton workButton--quiet" disabled={pending} onClick={onClose}>Cancel</button><button className="workButton" disabled={pending || loading}>{pending ? "Saving…" : agent ? "Save profile" : "Create agent"}</button></footer>
    </form>
  </dialog>;
}
