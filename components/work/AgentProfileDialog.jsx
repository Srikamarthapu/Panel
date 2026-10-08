"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useWorkSessions, workRequest } from "./WorkSessionProvider.jsx";
import useModelCatalog from "@/components/control/useModelCatalog.js";
import { AVATAR_PALETTES } from "@/lib/interface-preferences.js";
import styles from "./AgentProfileDialog.module.css";

function PathRow({ label, value, copied, onCopy }) {
  if (!value) return null;
  const accessibleLabel = label === "SOUL.md" ? "instructions" : label.toLowerCase();
  return <div className={styles.pathRow}><dt>{label}</dt><dd><code tabIndex={0}>{value}</code><button type="button" aria-label={`Copy ${accessibleLabel} path`} title={`Copy ${accessibleLabel} path`} onClick={() => onCopy(value, label)}>{copied === label ? <Check size={14} /> : <Copy size={14} />}</button></dd></div>;
}

export default function AgentProfileDialog({ agent, onClose }) {
  const work = useWorkSessions();
  const dialog = useRef(null), first = useRef(null), sending = useRef(false), id = useRef(null);
  const [form, setForm] = useState({ name: agent?.name || "", color: agent?.color || "sage", soul: "", workingDirectory: agent?.workingDirectory || "", provider: agent?.provider || "", model: agent?.model || "" });
  const [paths, setPaths] = useState(agent ? { storagePath: agent.storagePath, workspacePath: agent.workspacePath || agent.workingDirectory, soulPath: agent.soulPath } : null);
  const [copied, setCopied] = useState("");
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
      setForm({ name: data.agent.name, color: data.agent.color || "sage", soul: data.agent.soul, workingDirectory: data.agent.workingDirectory, provider: data.agent.provider, model: data.agent.model });
      setPaths({ storagePath: data.agent.storagePath, workspacePath: data.agent.workspacePath || data.agent.workingDirectory, soulPath: data.agent.soulPath });
      setLoading(false);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [agent]);
  function field(key) { return { value: form[key], onChange: event => setForm(previous => ({ ...previous, [key]: event.target.value })) }; }
  async function copyPath(value, label) {
    try { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(""), 1400); }
    catch { setError("That path could not be copied. Select the text and copy it manually."); }
  }
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
      <label>Agent color<select {...field("color")} className={styles.select}>{Object.entries(AVATAR_PALETTES).map(([value, palette]) => <option key={value} value={value}>{palette.label}</option>)}</select></label>
      <label>SOUL.md<textarea {...field("soul")} rows={7} maxLength={20000} spellCheck={false} placeholder="Describe this agent’s role, working style, and responsibilities." aria-describedby="agent-soul-help" /></label>
      <p className="fieldHelp" id="agent-soul-help">Saved as a real SOUL.md file. Give this agent a clear specialty so Hermes can choose it for the right work.</p>
      <label>Working folder <span>Optional</span><input {...field("workingDirectory")} spellCheck={false} placeholder="Leave blank for a separate agent workspace" aria-describedby="agent-folder-help" /></label>
      <p className="fieldHelp" id="agent-folder-help">An existing absolute path, or a new private folder managed by Panel. Workspace separation is not a tool sandbox.</p>
      <div className="agentProfileDialog__models"><label>Provider<input {...field("provider")} list="agent-providers" placeholder="Workspace default" autoComplete="off" spellCheck={false} /></label><label>Model ID<input {...field("model")} list="agent-models" placeholder="Workspace default" autoComplete="off" spellCheck={false} /></label></div>
      <datalist id="agent-providers">{(catalog?.providers || []).filter(p => p.configured).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</datalist>
      <datalist id="agent-models">{(catalog?.providers || []).filter(p => p.id === form.provider).flatMap(p => p.models || []).map(m => <option key={typeof m === "string" ? m : m.id} value={typeof m === "string" ? m : m.id} />)}</datalist>
      <p className="fieldHelp">Set both to use a connected model, or leave both blank to follow your Talk &amp; Chat model. Credentials stay in your Hermes setup.</p>
      {paths && <section className={styles.paths} aria-labelledby="agent-paths-title"><h3 id="agent-paths-title">Files and workspace</h3><p>These locations contain profile metadata and instructions. Credentials are stored separately by your provider setup.</p><dl>
        <PathRow label="Storage" value={paths.storagePath} copied={copied} onCopy={copyPath} />
        <PathRow label="Workspace" value={paths.workspacePath} copied={copied} onCopy={copyPath} />
        <PathRow label="SOUL.md" value={paths.soulPath} copied={copied} onCopy={copyPath} />
      </dl><span className="srOnly" role="status" aria-live="polite">{copied ? `${copied} path copied` : ""}</span></section>}
    </fieldset>{loading && !error && <p role="status" className="fieldHelp">Loading profile…</p>}{error && <p role="alert" className="workError">{error}</p>}
      <footer><button type="button" className="workButton workButton--quiet" disabled={pending} onClick={onClose}>Cancel</button><button className="workButton" disabled={pending || loading}>{pending ? "Saving…" : agent ? "Save profile" : "Create agent"}</button></footer>
    </form>
  </dialog>;
}
