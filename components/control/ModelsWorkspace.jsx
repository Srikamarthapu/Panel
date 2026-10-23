"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, ChevronRight, RefreshCw, Search } from "lucide-react";
import useModelCatalog from "./useModelCatalog.js";
import JevRouterSettings from "./JevRouterSettings.jsx";
import ProviderSetup from "./ProviderSetup.jsx";
import { catalogModels, filterCatalogModels, currentModelForRole, isCurrentModel, modelSourceLabel, modelAvailabilityLabel, modelSelectionState, canAssignCustomModel } from "@/lib/model-catalog-view.js";
import styles from "./ModelsWorkspace.module.css";
import { useModelResolution } from "./ModelResolutionProvider.jsx";
import ModelConflictPrompt from "./ModelConflictPrompt.jsx";

const ROLES = [
  { id: "primary", label: "Main model", short: "main", description: "The default for your agent’s work." },
  { id: "fallback", label: "Backup model", short: "backup", description: "Used if the main model cannot respond." },
  { id: "chat", label: "Chat", short: "Chat", description: "Follow Main or pin a model for written conversations." },
  { id: "talk", label: "Talk", short: "Talk", description: "Follow Main or pin a fast model for spoken conversations." },
];
const roleName = id => id === "voice" ? "Talk" : ROLES.find(item => item.id === id)?.label || id;
const isSurfaceRole = role => role === "chat" || role === "talk";

function surfaceSelectionState(resolution, loading) {
  if (!resolution) return { state: "unknown", assignment: null, effective: null, label: loading ? "Reading route" : "Route unavailable" };
  const effective = resolution.requestedModel ? { provider: resolution.requestedProvider, model: resolution.requestedModel } : null;
  return { state: resolution.followsMain ? "inherited" : "pinned", assignment: resolution.followsMain ? null : effective, effective, label: resolution.followsMain ? "Following Main" : resolution.originLabel || "Pinned" };
}

function AccessBadge({ model, fallback = "Access unknown" }) {
  const state = model?.accessState || "unknown";
  const tone = state === "unknown" ? styles.unknown : state === "untested" ? styles.untested : "";
  return <span className={`modelAccessBadge ${tone}`} data-state={state}>{model?.accessLabel || (model ? modelAvailabilityLabel(model) : fallback)}</span>;
}

export default function ModelsWorkspace() {
  const router = useRouter();
  const modelResolution = useModelResolution();
  const { catalog, loading, refreshing, error, warning, load } = useModelCatalog();
  const [role, setRole] = useState("primary");
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(24);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [customProvider, setCustomProvider] = useState("");
  const [customModel, setCustomModel] = useState("");
  const providers = catalog?.providers || [];
  const models = useMemo(() => catalogModels(catalog), [catalog]);
  const selected = isSurfaceRole(role)
    ? modelResolution[role]?.requestedModel ? { provider: modelResolution[role].requestedProvider, model: modelResolution[role].requestedModel } : null
    : currentModelForRole(catalog, role);
  const primary = currentModelForRole(catalog, "primary");
  const effectiveSelection = selected || (isSurfaceRole(role) ? primary : null);
  const connectedProviders = providers.filter(item => item.configured || item.savedLocally);
  const otherProviders = providers.filter(item => !item.configured && !item.savedLocally);
  const effectiveProvider = provider || effectiveSelection?.provider || providers.find(item => item.configured)?.id || "configured";
  const providerInfo = providers.find(item => item.id === effectiveProvider);
  const eligibleCustomProviders = providers.filter(item => item.configured && item.supportsCustomModel !== false);
  const customProviderId = customProvider || (providerInfo?.configured && providerInfo.supportsCustomModel !== false ? providerInfo.id : eligibleCustomProviders[0]?.id || "");
  const selectedCustomProvider = providers.find(item => item.id === customProviderId);
  const roleInfo = ROLES.find(item => item.id === role);
  const surfaceResolution = isSurfaceRole(role) ? modelResolution[role] : null;
  const surfaceManagedElsewhere = surfaceResolution?.executionMode === "direct" || surfaceResolution?.origin === "agent";
  const surfaceManagedByAgent = surfaceResolution?.origin === "agent";
  const providerModels = models.filter(model => effectiveProvider === "configured" ? model.configured || model.savedRoles?.length : model.provider === effectiveProvider);
  const hiddenCount = providerModels.filter(model => !model.selectable && !model.savedRoles?.length).length;
  const visibleModels = showUnavailable ? models : models.filter(model => model.selectable || model.savedRoles?.length);
  const filtered = filterCatalogModels(visibleModels, { provider: effectiveProvider, query, role, showUnavailable })
    .slice().sort((a, b) => Number(isCurrentModel(b, effectiveSelection)) - Number(isCurrentModel(a, effectiveSelection)) || Number(Boolean(b.savedRoles?.length)) - Number(Boolean(a.savedRoles?.length)));

  function chooseProvider(id) {
    setProvider(id); setLimit(24); setQuery(""); setShowUnavailable(false); setNotice(null);
  }
  function chooseRole(id) {
    setRole(id); setProvider(""); setLimit(24); setQuery(""); setShowUnavailable(false); setNotice(null);
  }
  async function assign(providerId, modelId, key = "custom") {
    if (surfaceManagedElsewhere) {
      setNotice({ kind: "error", text: surfaceManagedByAgent ? "This teammate has its own model. Change the teammate to update the next request." : "Direct API settings control this route." });
      return;
    }
    setBusy(`save:${key}`); setNotice(null);
    try {
      let data;
      if (isSurfaceRole(role)) {
        data = await modelResolution.updateSurface(role, modelId ? { mode: "pin", provider: providerId, model: modelId } : { mode: "follow-main" });
      } else if (role === "primary") {
        data = await modelResolution.switchMain({ provider: providerId, model: modelId });
        setConflicts(data.conflicts || []);
      } else {
        const response = await fetch("/api/models/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, model: modelId, role }), signal: AbortSignal.timeout(20_000) });
        data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "The model could not be saved. Try again.");
      }
      const refreshed = await load();
      setNotice(!refreshed
        ? { kind: "warning", text: `${roleName(role)} was saved, but this page could not confirm the refreshed settings. Reload before starting the next request.` }
        : { kind: "success", text: isSurfaceRole(role) && !modelId ? `${roleName(role)} now follows Main for new requests.` : `${roleName(role)} saved. ${role === "primary" ? "New agent sessions use this choice." : "New requests use the updated configuration."}` });
      router.refresh();
    } catch (failure) {
      setNotice({ kind: "error", text: failure.name === "TimeoutError" ? "Saving took longer than expected. Reload your choices before retrying." : failure.message });
    } finally { setBusy(""); }
  }
  async function testAccess(model) {
    setBusy(`test:${model.key}`); setNotice(null);
    try {
      const response = await fetch("/api/models/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: model.provider, model: model.model }), signal: AbortSignal.timeout(25_000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.result) throw new Error(data.error || "The connection test could not finish. Try again.");
      setNotice({ kind: data.result.ok ? "success" : "error", text: `${model.label}: ${data.result.detail || (data.result.ok ? "Connection test passed." : "Connection test failed. You can retry.")}` });
      await load();
    } catch (failure) {
      setNotice({ kind: "error", text: failure.name === "TimeoutError" ? "The connection test timed out. Your saved choices are unchanged." : failure.message });
    } finally { setBusy(""); }
  }
  function providerButton(item) {
    const count = models.filter(model => model.provider === item.id && model.selectable).length;
    return <button type="button" key={item.id} aria-pressed={effectiveProvider === item.id} onClick={() => chooseProvider(item.id)}>
      <span>{item.label || item.id}<em>{item.configured ? `${count} ${count === 1 ? "choice" : "choices"}` : item.savedLocally ? "Saved · check connection" : "Connection needed"}</em></span>
      {effectiveProvider === item.id ? <ChevronRight size={14} /> : <span className="providerConnectionDot" data-connected={item.configured} aria-hidden="true" />}
    </button>;
  }

  return <section className="modelWorkspace modelWorkspaceV2" aria-busy={loading || refreshing}>
    <ProviderSetup onRefresh={() => load(true)} />
    <p className="modelCatalogHint">These choices apply to future runs in their listed scope. A saved teammate can use its own pinned provider and model; that model appears on the active surface while the teammate is selected.</p>
    <div className="modelAssignments" aria-label="Current model assignments">
      {ROLES.map(item => {
        const selectionState = isSurfaceRole(item.id) ? surfaceSelectionState(modelResolution[item.id], modelResolution.loading) : modelSelectionState(catalog, item.id);
        const assignment = selectionState.assignment;
        const unknown = selectionState.state === "unknown";
        const inherits = selectionState.state === "inherited";
        const assignedModel = models.find(model => isCurrentModel(model, selectionState.effective));
        const friendlyName = assignedModel?.label || (isSurfaceRole(item.id) ? modelResolution[item.id]?.friendlyName : "") || selectionState.effective?.model;
        const providerLabel = providers.find(p => p.id === selectionState.effective?.provider)?.label || selectionState.effective?.provider;
        return <button type="button" className="modelAssignment" key={item.id} aria-pressed={role === item.id} onClick={() => chooseRole(item.id)}>
          <span className="modelAssignment__label">{item.label}<span aria-hidden="true">{role === item.id ? <Check size={14} /> : <ChevronRight size={14} />}</span></span>
          <strong title={selectionState.effective?.model || undefined}>{unknown ? (loading || modelResolution.loading ? "Loading…" : "Could not load") : friendlyName || (inherits ? "Follow Main" : "Not set")}</strong>
          <small>{inherits && primary?.model ? `${primary.provider} / ${primary.model}` : providerLabel || item.description}</small>
          <span className="modelAssignment__state">{unknown ? (loading ? "Reading your setup" : "Retry the catalog below") : assignment || inherits ? <>{selectionState.label} · <AccessBadge model={assignedModel} /></> : "Choose a model below"}</span>
        </button>;
      })}
    </div>

    {error ? <div className="modelNotice is-error" role="alert"><span>{error}</span><button type="button" onClick={() => load()}>Retry</button></div> : null}
    {warning ? <p className="modelNotice is-warning" role="status">{warning}</p> : null}
    {notice ? <p className={`modelNotice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p> : null}
    <ModelConflictPrompt conflicts={conflicts} busy={Boolean(busy)} onFollow={async surface => { setBusy(`follow:${surface}`); try { await modelResolution.updateSurface(surface, { mode: "follow-main" }); setConflicts(current => current.filter(item => item.surface !== surface)); setNotice({ kind: "success", text: `${surface === "chat" ? "Chat" : "Talk"} now follows Main.` }); } catch (failure) { setNotice({ kind: "error", text: failure.message }); } finally { setBusy(""); } }} onKeep={surface => setConflicts(current => current.filter(item => item.surface !== surface))} />

    <div className="modelCatalogLayout">
      <aside className="modelProviders" aria-label="Choose a provider">
        <span className="modelSectionLabel">Your connections</span>
        {connectedProviders.map(providerButton)}
        {!loading && catalog && !connectedProviders.length ? <p className="modelProviderEmpty">Connect a provider in Hermes to get started.</p> : null}
        <button type="button" className="modelAllConnections" aria-pressed={effectiveProvider === "configured"} onClick={() => chooseProvider("configured")}><span>All connected models</span></button>
        {otherProviders.length ? <details className="modelOtherProviders"><summary>Other providers <span>{otherProviders.length}</span></summary>{otherProviders.map(providerButton)}</details> : null}
      </aside>

      <section className="modelCatalogResults" aria-label="Choose a model">
        <div className="modelCatalogToolbar">
          <div><span className="modelSectionLabel">Choosing for {roleInfo.label}</span><h2>{providerInfo?.label || "Your connected models"}</h2><p>{roleInfo.description}</p></div>
          <button type="button" className="buttonLink" onClick={() => load(true, providerInfo?.id || "")} disabled={refreshing || loading || !!busy}><RefreshCw size={14} className={refreshing ? "is-refreshing" : ""} />{refreshing ? "Refreshing…" : "Refresh models"}</button>
        </div>
        {providerInfo && !providerInfo.configured ? <div className="modelConnectionHelp"><strong>{providerInfo.savedLocally ? "Check this connection" : `Connect ${providerInfo.label || providerInfo.id}`}</strong><p>{providerInfo.savedLocally ? "Your saved choice is kept. Hermes could not confirm this provider’s setup." : "This provider is available in Hermes. Finish its setup to choose a model here."}</p><p>Open a terminal, run <code>hermes model</code>, and choose this provider. Then refresh this page.</p></div> : null}
        {providerInfo?.catalogError || providerInfo?.catalogNote ? <p className="modelCatalogHint" role="status">{[providerInfo.catalogNote, providerInfo.catalogError].filter(Boolean).join(" ")}</p> : null}
        {surfaceManagedElsewhere ? <div className="modelConnectionHelp"><strong>{surfaceManagedByAgent ? surfaceResolution.originLabel || "Managed by this teammate" : "Managed by Direct API"}</strong><p>{surfaceManagedByAgent ? "This teammate has its own model. Global Chat and Talk pins remain unchanged." : "Direct API settings choose the model for this route. Your Hermes pins stay saved for Local mode."}</p><Link href={surfaceManagedByAgent ? "/agents" : "/settings"}>{surfaceManagedByAgent ? "Open teammate settings" : "Open Direct API settings"}</Link></div> : null}
        {isSurfaceRole(role) ? <div className="modelDefaultRow"><div><strong>Follow Main</strong><span>{primary?.model ? `Currently ${primary.model}. Changes to Main also apply here.` : `Use Main for ${roleName(role)}.`}</span></div><button type="button" disabled={surfaceManagedElsewhere || !!busy || !catalog || catalog.degraded || modelResolution[role]?.followsMain} onClick={() => assign("", "", "default")}>{modelResolution[role]?.followsMain ? "Following Main" : "Follow Main"}</button></div> : null}
        <div className="modelSearch"><label><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search models" placeholder={`Search ${providerInfo?.label || "your"} models…`} value={query} onChange={event => { setQuery(event.target.value); setLimit(24); }} /></label><span>{filtered.length} {filtered.length === 1 ? "model" : "models"}</span></div>
        {loading ? <p className="modelCatalogEmpty" role="status">Loading your model choices…</p> : !filtered.length ? <div className="modelCatalogEmpty"><strong>{query ? "No models match your search." : !providerInfo?.configured && providerInfo ? "Connect this provider to choose a model." : "No selectable models in this view."}</strong><p>{query ? "Try a model name or clear the search." : "Refresh the provider list, choose another connection, or enter an exact model ID below."}</p></div> : <div className="modelCatalogList">
          {filtered.slice(0, limit).map(model => {
            const active = isCurrentModel(model, selected);
            const inherited = isSurfaceRole(role) && modelResolution[role]?.followsMain && isCurrentModel(model, primary);
            return <article className="modelCatalogRow" key={model.key} data-selected={active || inherited} data-selection-state={inherited ? "inherited" : active ? (isSurfaceRole(role) ? "pinned" : "selected") : "available"}>
              <div className="modelRowSummary"><div className="modelRowIdentity"><strong>{model.label}</strong><AccessBadge model={model} />{effectiveProvider === "configured" ? <span className="modelProviderLabel">{model.providerLabel}</span> : null}</div>
                <div className="modelRowActions">{active || inherited ? <span className="modelSelectedLabel"><Check size={13} />{inherited ? "Following Main" : isSurfaceRole(role) ? surfaceManagedElsewhere ? "Current route" : "Pinned" : `Saved as ${roleInfo.short}`}</span> : <button type="button" disabled={surfaceManagedElsewhere || !!busy || !model.selectable} onClick={() => assign(model.provider, model.model, model.key)}>{busy === `save:${model.key}` ? "Saving…" : surfaceManagedElsewhere ? "Managed elsewhere" : model.selectable ? `${isSurfaceRole(role) ? "Pin for" : "Use as"} ${roleInfo.short}` : "Unavailable"}</button>}</div>
              </div>
              <details className="modelRowDetails"><summary>Model details{model.savedRoles?.length ? <span>{model.savedRoles.map(roleName).join(" · ")}</span> : null}</summary>
                <div className="modelRowDetailBody"><dl><div><dt>Model ID</dt><dd><code>{model.model}</code></dd></div><div><dt>Source</dt><dd>{modelSourceLabel(model.source)}</dd></div></dl><p>{model.accessDetail || model.availabilityNote || "Your provider is connected. A connection test checks this exact model without changing your choices."}</p>
                  {model.checkedAt || model.probe?.checkedAt ? <p className="modelCatalogHint">Last tested {new Date(model.checkedAt || model.probe.checkedAt).toLocaleString()}</p> : null}
                  {model.canTest ? <button type="button" className="modelTestButton" disabled={!!busy} onClick={() => testAccess(model)}>{busy === `test:${model.key}` ? "Testing connection…" : "Test access"}</button> : <p className="modelCatalogHint">{model.probeNote || (!model.configured ? "Connect this provider before testing." : "This provider’s access is checked through its Hermes conversation runtime.")}</p>}
                </div>
              </details>
            </article>;
          })}
        </div>}
        {filtered.length > limit ? <button type="button" className="modelLoadMore" onClick={() => setLimit(value => value + 24)}>Show {Math.min(24, filtered.length - limit)} more models</button> : null}
        {hiddenCount ? <label className="modelUnavailableToggle"><input type="checkbox" checked={showUnavailable} onChange={event => { setShowUnavailable(event.target.checked); setLimit(24); }} />Show {hiddenCount} unavailable catalog {hiddenCount === 1 ? "entry" : "entries"}</label> : null}
        <p className="modelCatalogHint">Saved choice controls a future request. Test passed means this exact model answered a short provider request. No test result means access is unknown; tests use a small amount of your provider’s quota.</p>
      </section>
    </div>

    <details className="modelCustom"><summary>Use an exact model ID</summary><form onSubmit={event => { event.preventDefault(); if (!surfaceManagedElsewhere && !catalog?.degraded && canAssignCustomModel(selectedCustomProvider, role, customModel)) assign(customProviderId, customModel.trim()); }}>
      <p>For a model your connected provider supports that is missing from its catalog.</p>
      <label><span>Provider</span><select value={customProviderId} onChange={event => setCustomProvider(event.target.value)}><option value="">Select provider</option>{eligibleCustomProviders.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label>
      <label><span>Model ID</span><input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="Exact provider model ID" autoComplete="off" spellCheck={false} /></label>
      <button type="submit" disabled={surfaceManagedElsewhere || !!busy || catalog?.degraded || !canAssignCustomModel(selectedCustomProvider, role, customModel)}>{busy === "save:custom" ? "Saving…" : `Save ${roleInfo.short} model`}</button>
    </form></details>
    <details className="modelRoutingDetails"><summary><div><strong>Jev routing</strong><span>How your agent chooses models and tools</span></div><ChevronRight size={16} aria-hidden="true" /></summary><JevRouterSettings /></details>
  </section>;
}
