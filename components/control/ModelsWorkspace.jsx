"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useVoice } from "@/components/voice/VoiceProvider.jsx";
import useModelCatalog from "./useModelCatalog.js";
import JevRouterSettings from "./JevRouterSettings.jsx";
import { catalogModels, filterCatalogModels, currentModelForRole, isCurrentModel, modelSourceLabel, modelAvailabilityLabel, canAssignCustomModel } from "@/lib/model-catalog-view.js";

const ROLES = [
  { id: "primary", label: "Main model", short: "main", description: "The default for your agent’s work." },
  { id: "fallback", label: "Backup model", short: "backup", description: "Used if the main model cannot respond." },
  { id: "voice", label: "Talk & Chat", short: "conversation", description: "A shared choice for written and spoken conversations." },
];
const roleName = id => ROLES.find(item => item.id === id)?.label || id;

function AccessBadge({ model, fallback = "Configured" }) {
  return <span className="modelAccessBadge" data-state={model?.accessState || "configured"}>{model?.accessLabel || (model ? modelAvailabilityLabel(model) : fallback)}</span>;
}

export default function ModelsWorkspace() {
  const router = useRouter();
  const voice = useVoice();
  const { catalog, loading, refreshing, error, warning, load } = useModelCatalog();
  const [role, setRole] = useState("primary");
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(24);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);
  const [customProvider, setCustomProvider] = useState("");
  const [customModel, setCustomModel] = useState("");
  const providers = catalog?.providers || [];
  const models = useMemo(() => catalogModels(catalog), [catalog]);
  const selected = currentModelForRole(catalog, role);
  const primary = currentModelForRole(catalog, "primary");
  const effectiveSelection = selected || (role === "voice" ? primary : null);
  const connectedProviders = providers.filter(item => item.configured || item.savedLocally);
  const otherProviders = providers.filter(item => !item.configured && !item.savedLocally);
  const effectiveProvider = provider || effectiveSelection?.provider || providers.find(item => item.configured)?.id || "configured";
  const providerInfo = providers.find(item => item.id === effectiveProvider);
  const eligibleCustomProviders = providers.filter(item => item.configured && item.supportsCustomModel !== false);
  const customProviderId = customProvider || (providerInfo?.configured && providerInfo.supportsCustomModel !== false ? providerInfo.id : eligibleCustomProviders[0]?.id || "");
  const selectedCustomProvider = providers.find(item => item.id === customProviderId);
  const roleInfo = ROLES.find(item => item.id === role);
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
    setBusy(`save:${key}`); setNotice(null);
    try {
      const response = await fetch("/api/models/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, model: modelId, role }), signal: AbortSignal.timeout(20_000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The model could not be saved. Try again.");
      if (role === "voice" && voice) {
        const synced = await voice.updateConfig({ voiceModelProvider: providerId, voiceModel: modelId }, { persist: false });
        if (!synced) throw new Error("Your choice was saved, but this conversation could not refresh its settings. Reload before starting the next turn.");
      }
      setNotice({ kind: "success", text: role === "voice" && !modelId ? "Talk and Chat now follow your main model." : `${roleName(role)} saved. ${role === "primary" ? "New agent sessions use this choice." : "New requests use the updated configuration."}` });
      await load(); router.refresh();
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

  return <section className="modelWorkspace modelWorkspaceV2">
    <div className="modelAssignments" aria-label="Current model assignments">
      {ROLES.map(item => {
        const assignment = currentModelForRole(catalog, item.id);
        const unknown = !catalog;
        const inherits = !unknown && item.id === "voice" && !assignment;
        const assignedModel = models.find(model => isCurrentModel(model, assignment));
        const providerLabel = providers.find(p => p.id === assignment?.provider)?.label || assignment?.provider;
        return <button type="button" className="modelAssignment" key={item.id} aria-pressed={role === item.id} onClick={() => chooseRole(item.id)}>
          <span className="modelAssignment__label">{item.label}<span aria-hidden="true">{role === item.id ? <Check size={14} /> : <ChevronRight size={14} />}</span></span>
          <strong>{unknown ? (loading ? "Loading…" : "Could not load") : assignment?.model || (inherits ? "Follow main model" : "Not set")}</strong>
          <small>{inherits && primary?.model ? primary.model : providerLabel || item.description}</small>
          <span className="modelAssignment__state">{unknown ? (loading ? "Reading your setup" : "Retry the catalog below") : assignment ? <AccessBadge model={assignedModel} /> : inherits ? "Shared with your agent" : "Choose a model below"}</span>
        </button>;
      })}
    </div>

    {error ? <div className="modelNotice is-error" role="alert"><span>{error}</span><button type="button" onClick={() => load()}>Retry</button></div> : null}
    {warning ? <p className="modelNotice is-warning" role="status">{warning}</p> : null}
    {notice ? <p className={`modelNotice is-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p> : null}

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
        {role === "voice" ? <div className="modelDefaultRow"><div><strong>Follow main model</strong><span>{primary?.model ? `Currently ${primary.model}. Changes to your main model also apply here.` : "Use your agent’s main model for Talk and Chat."}</span></div><button type="button" disabled={!!busy || !catalog || catalog.degraded || catalog.voice?.usesDefault} onClick={() => assign("", "", "default")}>{catalog?.voice?.usesDefault ? "Following main" : "Use main model"}</button></div> : null}
        <div className="modelSearch"><label><Search size={16} aria-hidden="true" /><input type="search" aria-label="Search models" placeholder={`Search ${providerInfo?.label || "your"} models…`} value={query} onChange={event => { setQuery(event.target.value); setLimit(24); }} /></label><span>{filtered.length} {filtered.length === 1 ? "model" : "models"}</span></div>
        {loading ? <p className="modelCatalogEmpty" role="status">Loading your model choices…</p> : !filtered.length ? <div className="modelCatalogEmpty"><strong>{query ? "No models match your search." : !providerInfo?.configured && providerInfo ? "Connect this provider to choose a model." : "No selectable models in this view."}</strong><p>{query ? "Try a model name or clear the search." : "Refresh the provider list, choose another connection, or enter an exact model ID below."}</p></div> : <div className="modelCatalogList">
          {filtered.slice(0, limit).map(model => {
            const active = isCurrentModel(model, selected);
            const inherited = role === "voice" && !selected && isCurrentModel(model, primary);
            return <article className="modelCatalogRow" key={model.key} data-selected={active || inherited}>
              <div className="modelRowSummary"><div className="modelRowIdentity"><strong>{model.label}</strong><AccessBadge model={model} />{effectiveProvider === "configured" ? <span className="modelProviderLabel">{model.providerLabel}</span> : null}</div>
                <div className="modelRowActions">{active || inherited ? <span className="modelSelectedLabel"><Check size={13} />{inherited ? "Following main" : "Selected"}</span> : <button type="button" disabled={!!busy || !model.selectable} onClick={() => assign(model.provider, model.model, model.key)}>{busy === `save:${model.key}` ? "Saving…" : model.selectable ? `Use as ${roleInfo.short}` : "Unavailable"}</button>}</div>
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
        <p className="modelCatalogHint">Configured means saved in your setup. Test passed means this exact model answered a short provider request. Tests use a small amount of your provider’s quota.</p>
      </section>
    </div>

    <details className="modelCustom"><summary>Use an exact model ID</summary><form onSubmit={event => { event.preventDefault(); if (!catalog?.degraded && canAssignCustomModel(selectedCustomProvider, role, customModel)) assign(customProviderId, customModel.trim()); }}>
      <p>For a model your connected provider supports that is missing from its catalog.</p>
      <label><span>Provider</span><select value={customProviderId} onChange={event => setCustomProvider(event.target.value)}><option value="">Select provider</option>{eligibleCustomProviders.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label>
      <label><span>Model ID</span><input value={customModel} onChange={event => setCustomModel(event.target.value)} placeholder="Exact provider model ID" autoComplete="off" spellCheck={false} /></label>
      <button type="submit" disabled={!!busy || catalog?.degraded || !canAssignCustomModel(selectedCustomProvider, role, customModel)}>{busy === "save:custom" ? "Saving…" : `Save ${roleInfo.short} model`}</button>
    </form></details>
    <details className="modelRoutingDetails"><summary><div><strong>Jev routing</strong><span>How your agent chooses models and tools</span></div><ChevronRight size={16} aria-hidden="true" /></summary><JevRouterSettings /></details>
  </section>;
}
