"use client";

import Link from "next/link";
import { Check, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { catalogModels } from "@/lib/model-catalog-view.js";
import useModelCatalog from "./useModelCatalog.js";
import { useModelResolution } from "./ModelResolutionProvider.jsx";
import ModelConflictPrompt from "./ModelConflictPrompt.jsx";

function sameModel(resolution, model) {
  return resolution?.requestedProvider === model.provider && resolution?.requestedModel === model.model;
}

export default function ModelPicker({ surface, onClose }) {
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef(null);
  const search = useRef(null);
  const resolutionState = useModelResolution();
  const resolution = resolutionState[surface];
  const canBrowseCatalog = Boolean(resolution && resolution.executionMode !== "direct" && resolution.origin !== "agent");
  const { catalog, loading: catalogLoading, error: catalogError } = useModelCatalog(canBrowseCatalog);
  const models = useMemo(() => catalogModels(catalog).filter(model => model.selectable), [catalog]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("surface");
  const [effort, setEffort] = useState(resolution?.reasoningEffort || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflicts, setConflicts] = useState([]);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = models.filter(model => !normalized || `${model.label} ${model.model} ${model.providerLabel} ${model.provider}`.toLocaleLowerCase().includes(normalized)).slice(0, 80);
  const direct = resolution?.executionMode === "direct";
  const agentPinned = resolution?.origin === "agent";

  useEffect(() => {
    const modal = dialog.current;
    modal.showModal();
    search.current?.focus();
    return () => modal.close();
  }, []);

  useEffect(() => {
    setEffort(resolution?.reasoningEffort || "");
  }, [surface, resolution?.reasoningEffort]);

  async function choose(model) {
    setBusy(model.key); setError(""); setNotice(""); setConflicts([]);
    try {
      if (scope === "main") {
        const payload = await resolutionState.switchMain({ provider: model.provider, model: model.model });
        setConflicts(payload.conflicts || []);
        setNotice(payload.conflicts?.length ? `${model.label} is now Main. Choose whether each pinned surface should follow it.` : `${model.label} is now the Main model.`);
      } else {
        await resolutionState.updateSurface(surface, { mode: "pin", provider: model.provider, model: model.model, reasoningEffort: effort });
        setNotice(`${model.label} is pinned for ${surface === "chat" ? "Chat" : "Talk"}.`);
      }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  }

  async function followMain(target = surface) {
    setBusy(`follow:${target}`); setError("");
    try {
      await resolutionState.updateSurface(target, { mode: "follow-main", ...(target === surface ? { reasoningEffort: effort } : {}) });
      setConflicts(current => current.filter(item => item.surface !== target));
      setNotice(`${target === "chat" ? "Chat" : "Talk"} now follows Main.`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  }

  return <dialog ref={dialog} className="modelPicker" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2 id={titleId}>Choose a model for {surface === "chat" ? "Chat" : "Talk"}</h2><p id={descriptionId}>The selected route is used for the next request.</p></div><button type="button" className="modelPicker__close" aria-label="Close model picker" onClick={onClose}><X size={17} aria-hidden="true" /></button></header>
    {!resolution ? <div className="modelPicker__direct"><strong>{resolutionState.loading ? "Resolving the next model…" : "Model route unavailable"}</strong><p>{resolutionState.error || "Panel could not confirm which model the next request would use."}</p><button type="button" onClick={resolutionState.refresh}>Retry</button></div> : agentPinned ? <div className="modelPicker__direct"><strong>{resolution.friendlyName || resolution.label || resolution.requestedModel}</strong><p>{resolution.originLabel || "This teammate has its own model"}. Change the teammate to update the next request.</p><Link href="/agents" onClick={onClose}>Open teammate settings</Link></div> : direct ? <div className="modelPicker__direct"><strong>{resolution.friendlyName || resolution.label || resolution.requestedModel}</strong><p>Direct API mode controls this route. Hermes surface pins are left unchanged.</p><Link href="/settings" onClick={onClose}>Open Direct API settings</Link></div> : <>
      <fieldset className="modelPicker__scope"><legend>Use selection for</legend><label><input type="radio" name="model-scope" value="surface" checked={scope === "surface"} onChange={() => setScope("surface")} />{surface === "chat" ? "Chat" : "Talk"}</label><label><input type="radio" name="model-scope" value="main" checked={scope === "main"} onChange={() => setScope("main")} />Main model</label></fieldset>
      <label className="modelPicker__effort"><span>Effort for {surface === "chat" ? "Chat" : "Talk"}</span><select value={effort} disabled={scope === "main"} onChange={event => setEffort(event.target.value)}><option value="">Model default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <button type="button" className="modelPicker__follow" disabled={Boolean(busy) || resolution?.followsMain} onClick={() => followMain()}><span><strong>Follow Main</strong><small>Use Main automatically when it changes.</small></span>{resolution?.followsMain && <Check size={16} aria-hidden="true" />}</button>
      <label className="modelPicker__search"><Search size={16} aria-hidden="true" /><span className="srOnly">Search models</span><input ref={search} type="search" value={query} placeholder="Search models and providers" onChange={event => setQuery(event.target.value)} /></label>
      {catalogLoading ? <p className="modelPicker__empty" role="status">Loading model choices…</p> : catalogError ? <p className="modelPicker__error" role="alert">{catalogError}</p> : !visible.length ? <p className="modelPicker__empty">No connected models match this search.</p> : <ul className="modelPicker__list">{visible.map(model => <li key={model.key}><button type="button" disabled={Boolean(busy)} title={`${model.provider} / ${model.model}`} onClick={() => choose(model)}><span className="modelPicker__providerMark" aria-hidden="true">{(model.providerLabel || model.provider).slice(0, 1).toLocaleUpperCase()}</span><span><strong>{model.label}</strong><small>{model.providerLabel} · {scope === "main" ? "Make Main" : `Pin for ${surface === "chat" ? "Chat" : "Talk"}`}</small></span>{sameModel(resolution, model) && resolution.origin !== "main" ? <Check size={16} aria-label="Current model" /> : null}</button></li>)}</ul>}
    </>}
    <ModelConflictPrompt conflicts={conflicts} busy={Boolean(busy)} onFollow={followMain} onKeep={target => setConflicts(current => current.filter(item => item.surface !== target))} />
    {(notice || error) && <p className={error ? "modelPicker__error" : "modelPicker__notice"} role={error ? "alert" : "status"}>{error || notice}</p>}
  </dialog>;
}
