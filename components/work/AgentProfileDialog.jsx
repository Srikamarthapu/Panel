"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useWorkSessions, workRequest } from "./WorkSessionProvider.jsx";
import useModelCatalog from "@/components/control/useModelCatalog.js";
import { AVATAR_PALETTES } from "@/lib/interface-preferences.js";
import styles from "./AgentProfileDialog.module.css";

const ROLE_TEMPLATES = Object.freeze([
  { name: "Researcher", role: "Find reliable sources, compare evidence, and report conclusions with citations and clear uncertainty.", tools: ["web_search", "web_extract", "read_file", "search_files"] },
  { name: "Builder", role: "Implement scoped changes, preserve existing behavior, run relevant checks, and report what changed and any limitations.", tools: ["read_file", "search_files", "write_file", "patch", "terminal", "process_manage"] },
  { name: "Reviewer", role: "Review work for correctness, usability, accessibility, and regressions. Lead with concrete findings and evidence.", tools: ["read_file", "search_files", "web_search", "web_extract"] },
]);

const emptyPolicy = () => ({ version: 1, tools: { mode: "allow", ids: [] }, skills: { mode: "allow", ids: [] } });

function PathRow({ label, value, copied, onCopy }) {
  if (!value) return null;
  const accessibleLabel = label === "SOUL.md" ? "instructions" : label.toLowerCase();
  return <div className={styles.pathRow}><dt>{label}</dt><dd><code tabIndex={0}>{value}</code><button type="button" aria-label={`Copy ${accessibleLabel} path`} title={`Copy ${accessibleLabel} path`} onClick={() => onCopy(value, label)}>{copied === label ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}</button></dd></div>;
}

function CapabilityList({ title, description, items, selected, onToggle, initiallyOpen = false }) {
  const [query, setQuery] = useState(""), [selectedOnly, setSelectedOnly] = useState(false), [open, setOpen] = useState(initiallyOpen);
  const known = new Set(items.map(item => item.id));
  const rows = [...items, ...selected.filter(id => !known.has(id)).map(id => ({ id, name: id, group: "Unavailable", description: "This capability is no longer installed. Remove it before saving.", available: false }))];
  const visible = rows.filter(item => (!selectedOnly || selected.includes(item.id)) && (!query.trim() || `${item.name} ${item.description} ${item.group}`.toLowerCase().includes(query.trim().toLowerCase())));
  const groups = visible.reduce((result, item) => { const group = item.group || "Other"; (result[group] ||= []).push(item); return result; }, {});
  return <details className={styles.capabilityDisclosure} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{title}</span><small>{selected.length} selected</small></summary>
    <div className={styles.capabilityBody}><p>{description}</p><div className={styles.capabilityFilters}><label><span className="srOnly">Search {title.toLowerCase()}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${title.toLowerCase()}`} /></label><label className={styles.selectedOnly}><input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} />Selected only</label></div>
      {Object.entries(groups).map(([group, groupItems]) => <section key={group} className={styles.capabilityGroup} aria-label={`${group} ${title.toLowerCase()}`}><h4>{group}</h4><div className={styles.optionGrid}>{groupItems.map(item => { const checked = selected.includes(item.id); return <label key={item.id} data-unavailable={item.available === false || undefined}><input type="checkbox" checked={checked} disabled={item.available === false && !checked} onChange={() => onToggle(item.id)} /><span><strong>{item.name}</strong><small>{item.description}</small></span></label>; })}</div></section>)}
      {!visible.length && <p className={styles.noMatches}>No matching capabilities.</p>}
    </div>
  </details>;
}

export default function AgentProfileDialog({ agent, onClose }) {
  const work = useWorkSessions();
  const dialog = useRef(null), first = useRef(null), sending = useRef(false), id = useRef(null);
  const [form, setForm] = useState({ name: agent?.name || "", color: agent?.color || "sage", soul: "", workingDirectory: agent?.workingDirectory || "", provider: agent?.provider || "", model: agent?.model || "", capabilityPolicy: agent ? null : emptyPolicy() });
  const [capabilities, setCapabilities] = useState(null), [capabilityError, setCapabilityError] = useState("");
  const [capabilityWarning, setCapabilityWarning] = useState(agent?.capabilityPolicyError || "");
  const [paths, setPaths] = useState(agent ? { storagePath: agent.storagePath, workspacePath: agent.workspacePath || agent.workingDirectory, soulPath: agent.soulPath } : null);
  const [copied, setCopied] = useState("");
  const [loading, setLoading] = useState(Boolean(agent)), [pending, setPending] = useState(false), [error, setError] = useState(""), [attempted, setAttempted] = useState(false);
  const { catalog } = useModelCatalog();
  useEffect(() => {
    const trigger = document.activeElement, modal = dialog.current;
    id.current = crypto.randomUUID(); modal.showModal(); first.current?.focus();
    return () => { modal.close(); if (trigger?.isConnected) trigger.focus?.(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    workRequest("/api/agents/capabilities", { signal: controller.signal }).then(setCapabilities).catch(failure => { if (!controller.signal.aborted) setCapabilityError(failure.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!agent) return;
    const controller = new AbortController();
    workRequest(`/api/agents/${agent.id}`, { signal: controller.signal }).then(data => {
      setForm({ name: data.agent.name, color: data.agent.color || "sage", soul: data.agent.soul, workingDirectory: data.agent.workingDirectory, provider: data.agent.provider, model: data.agent.model, capabilityPolicy: data.agent.capabilityPolicy });
      setCapabilityWarning(data.agent.capabilityPolicyError || "");
      setPaths({ storagePath: data.agent.storagePath, workspacePath: data.agent.workspacePath || data.agent.workingDirectory, soulPath: data.agent.soulPath });
      setLoading(false);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [agent]);
  function field(key) { return { value: form[key], onChange: event => { setForm(previous => ({ ...previous, [key]: event.target.value })); setError(""); } }; }
  function useTemplate(template) {
    setForm(previous => ({ ...previous, name: previous.name || template.name, soul: template.role, capabilityPolicy: { version: 1, tools: { mode: "allow", ids: template.tools }, skills: { mode: "allow", ids: [] } } }));
  }
  function toggleCapability(kind, value) {
    setForm(previous => {
      const policy = previous.capabilityPolicy || emptyPolicy();
      const selected = new Set(policy[kind].ids);
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      return { ...previous, capabilityPolicy: { ...policy, [kind]: { mode: "allow", ids: [...selected] } } };
    });
  }
  async function copyPath(value, label) {
    try { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(""), 1400); }
    catch { setError("That path could not be copied. Select the text and copy it manually."); }
  }
  async function save(event) {
    event.preventDefault(); if (sending.current || loading) return;
    setAttempted(true);
    if (!form.soul.trim()) {
      setError("Describe this teammate’s role before saving.");
      return;
    }
    if (Boolean(form.provider.trim()) !== Boolean(form.model.trim())) {
      setError("Choose both a provider and model, or leave both blank to use your Talk & Chat model.");
      return;
    }
    sending.current = true; setPending(true); setError("");
    try { await work.saveAgent({ ...form, ...(!agent ? { id: id.current } : {}), workingDirectory: form.workingDirectory.trim() || null }, agent?.id); onClose(); }
    catch (failure) { setError(failure.message); sending.current = false; setPending(false); }
  }
  const incompleteModel = Boolean(form.provider.trim()) !== Boolean(form.model.trim());
  const roleError = attempted && !form.soul.trim();
  const managedWorkspace = !form.workingDirectory.trim() || Boolean(agent?.storagePath && form.workingDirectory.trim() === `${agent.storagePath}/workspace`);
  const folderSummary = managedWorkspace ? "managed folder" : "custom folder";
  const modelSummary = form.provider.trim() && form.model.trim() ? `${form.provider.trim()}/${form.model.trim()}` : "Talk & Chat model";
  const directMode = work.directConfig?.executionMode === "direct";
  const inherited = form.capabilityPolicy === null;
  const selectedToolCount = form.capabilityPolicy?.tools.ids.length || 0;
  const selectedSkillCount = form.capabilityPolicy?.skills.ids.length || 0;
  return <dialog ref={dialog} className="sessionDialog agentProfileDialog" aria-labelledby="agent-profile-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <header><div><h2 id="agent-profile-title">{agent ? "Teammate profile" : "Create a teammate"}</h2><p>Save a specialist for work you expect to repeat.</p></div><button type="button" className="iconButton" aria-label="Close teammate profile" disabled={pending} onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <form onSubmit={save} aria-busy={pending || loading}><fieldset disabled={pending || loading}>
      <label>Teammate name<input ref={first} {...field("name")} required maxLength={120} placeholder="e.g. Researcher" autoComplete="off" /></label>
      {!agent && <div className={styles.templates} aria-label="Role templates"><span>Start with a role</span><div>{ROLE_TEMPLATES.map(template => <button key={template.name} type="button" onClick={() => useTemplate(template)}>{template.name}</button>)}</div></div>}
      <label>Role and working instructions<textarea {...field("soul")} rows={7} required maxLength={20000} placeholder="What should this teammate own? How should it work and report results?" aria-invalid={roleError || undefined} aria-describedby="agent-soul-help" /></label>
      <p className="fieldHelp" id="agent-soul-help">{roleError ? "A clear role is required." : "Be specific about responsibility, evidence, and what a finished result should include."} Panel saves this in the teammate’s SOUL.md.</p>
      <section className={styles.capabilities} aria-labelledby="agent-capabilities-title" aria-busy={!capabilities && !capabilityError}>
        <div className={styles.capabilityHead}><div><h3 id="agent-capabilities-title">Tools and skills</h3><p>{inherited ? "Legacy workspace access" : `${selectedToolCount} tools · ${selectedSkillCount} skills`}</p></div>{inherited && <button type="button" onClick={() => setForm(previous => ({ ...previous, capabilityPolicy: emptyPolicy() }))}>Choose access</button>}</div>
        {directMode && <p className={styles.modeNote}>Direct runtime is active. Direct model turns do not have tools or a skill loader; these saved choices take effect when this teammate runs through Hermes.</p>}
        {capabilityWarning && <p className={styles.policyWarning} role="alert">{capabilityWarning}</p>}
        {inherited ? <p className={styles.inherited}>This older profile still inherits the workspace’s configured capabilities. Choose access to replace that legacy behavior with an enforced allowlist.</p> : capabilities ? <>
          <CapabilityList title="Tools" description="Select only what this teammate needs. An empty list means no tools." items={capabilities.tools} selected={form.capabilityPolicy.tools.ids} onToggle={id => toggleCapability("tools", id)} initiallyOpen />
          <CapabilityList title="Skills" description="Skills provide saved workflows and instructions. An empty list means no skill discovery or loading." items={capabilities.skills} selected={form.capabilityPolicy.skills.ids} onToggle={id => toggleCapability("skills", id)} />
          <div className={styles.boundaryNote}><p>{capabilities.notes.workingDirectory}</p><p>{capabilities.notes.skillBoundary}</p><p>{capabilities.notes.delegation}</p><p>{capabilities.notes.runtime}</p></div>
        </> : <p className="fieldHelp" role={capabilityError ? "alert" : "status"}>{capabilityError || "Loading installed capabilities…"}</p>}
      </section>
      <details className={styles.advanced} open={incompleteModel || undefined}>
        <summary>Advanced setup <span>{modelSummary} · {folderSummary}</span></summary>
        <div className={styles.advancedFields}>
          <label>Color<select {...field("color")} className={styles.select}>{Object.entries(AVATAR_PALETTES).map(([value, palette]) => <option key={value} value={value}>{palette.label}</option>)}</select></label>
          <label>Working folder <span>Optional</span><input {...field("workingDirectory")} spellCheck={false} placeholder="Separate managed workspace" aria-describedby="agent-folder-help" /></label>
          <p className="fieldHelp" id="agent-folder-help">Use an existing absolute path, or leave blank for a separate folder managed by Panel. Folder separation does not restrict tool access.</p>
          <div className="agentProfileDialog__models"><label>Provider<input {...field("provider")} list="agent-providers" placeholder="Workspace default" autoComplete="off" spellCheck={false} aria-invalid={incompleteModel || undefined} aria-describedby="agent-model-help" /></label><label>Model ID<input {...field("model")} list="agent-models" placeholder="Workspace default" autoComplete="off" spellCheck={false} aria-invalid={incompleteModel || undefined} aria-describedby="agent-model-help" /></label></div>
          <datalist id="agent-providers">{(catalog?.providers || []).filter(p => p.configured).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</datalist>
          <datalist id="agent-models">{(catalog?.providers || []).filter(p => p.id === form.provider).flatMap(p => p.models || []).map(m => <option key={typeof m === "string" ? m : m.id} value={typeof m === "string" ? m : m.id} />)}</datalist>
          <p className="fieldHelp" id="agent-model-help">{incompleteModel ? "Choose both a provider and model, or clear both fields. " : ""}Leave both blank to follow your Talk &amp; Chat model. Setting a model does not test provider access.</p>
        </div>
      </details>
      {paths && <section className={styles.paths} aria-labelledby="agent-paths-title"><h3 id="agent-paths-title">Files and workspace</h3><p>These locations contain profile metadata and instructions. Credentials are stored separately by your provider setup.</p><dl>
        <PathRow label="Storage" value={paths.storagePath} copied={copied} onCopy={copyPath} />
        <PathRow label="Workspace" value={paths.workspacePath} copied={copied} onCopy={copyPath} />
        <PathRow label="SOUL.md" value={paths.soulPath} copied={copied} onCopy={copyPath} />
      </dl><span className="srOnly" role="status" aria-live="polite">{copied ? `${copied} path copied` : ""}</span></section>}
    </fieldset>{loading && !error && <p role="status" className="fieldHelp">Loading profile…</p>}{error && <p role="alert" className="workError">{error}</p>}
      <footer><button type="button" className="workButton workButton--quiet" disabled={pending} onClick={onClose}>Cancel</button><button className="workButton" disabled={pending || loading || Boolean(capabilityError)}>{pending ? "Saving…" : agent ? "Save teammate" : "Create teammate"}</button></footer>
    </form>
  </dialog>;
}
