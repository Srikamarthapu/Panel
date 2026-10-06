"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useModelCatalog from "@/components/control/useModelCatalog.js";
import { catalogModels, canAssignCustomModel } from "@/lib/model-catalog-view.js";

export default function VoiceModelPicker({ voice }) {
  const { catalog, loading, refreshing, error, load } = useModelCatalog();
  const [draftProvider, setDraftProvider] = useState(null);
  const [draftModel, setDraftModel] = useState(null);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const cfg = voice?.config || {};
  const providerId = draftProvider ?? cfg.voiceModelProvider ?? "";
  const modelId = draftModel ?? cfg.voiceModel ?? "";
  const providers = (catalog?.providers || []).filter((provider) => provider.configured && provider.canUseForVoice);
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const allModels = useMemo(() => catalogModels(catalog), [catalog]);
  const providerModels = allModels.filter((model) => model.provider === providerId && model.canUseForVoice);
  const matches = providerModels.filter((model) => `${model.label} ${model.model}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeListed = matches.some((model) => model.model === modelId);

  async function save(nextProvider, nextModel) {
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch("/api/models/switch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "voice", provider: nextProvider, model: nextModel }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The conversation model could not be saved.");
      const synced = await voice.updateConfig({ voiceModelProvider: nextProvider, voiceModel: nextModel });
      if (!synced) throw new Error("The model was saved. Reload this page to sync your conversation settings.");
    } catch (failure) {
      setSaveError(failure.message || "The conversation model could not be saved.");
      setDraftProvider(null);
      setDraftModel(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="voiceSettings__modelPicker">
      <label className="dockSettings__field"><span>Conversation provider</span><select value={providerId} disabled={saving} onChange={(event) => {
        const value = event.target.value;
        setDraftProvider(value); setDraftModel(""); setQuery(""); setCustom(false);
        if (!value) save("", "");
      }}>
        <option value="">Hermes default · allow Jev routing</option>
        {providerId && !selectedProvider ? <option value={providerId}>{providerId} · current provider</option> : null}
        {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label || provider.id}</option>)}
      </select></label>
      {providerId ? <>
        {providerModels.length > 12 ? <label className="voiceSettings__modelSearch"><span className="srOnly">Filter conversation models</span><input type="search" placeholder="Find a model…" value={query} onChange={(event) => setQuery(event.target.value)} /></label> : null}
        <label className="dockSettings__field"><span>Conversation model</span><select value={custom ? "__custom__" : modelId} disabled={saving || loading} onChange={(event) => {
          const value = event.target.value;
          if (value === "__custom__") { setCustom(true); setCustomModel(modelId); return; }
          setCustom(false); setDraftModel(value);
          if (value) save(providerId, value);
        }}>
          <option value="">Choose a model</option>
          {modelId && !activeListed ? <option value={modelId}>{modelId} · current</option> : null}
          {matches.map((model) => <option key={model.key} value={model.model} disabled={!model.selectable}>{model.label}</option>)}
          {selectedProvider?.supportsCustomModel !== false ? <option value="__custom__">Enter a custom model ID…</option> : null}
        </select></label>
        {custom ? <div className="voiceSettings__customModel"><label><span className="srOnly">Custom voice model ID</span><input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="Exact model ID" spellCheck={false} autoComplete="off" /></label><button type="button" className="voiceSettings__button" disabled={saving || !canAssignCustomModel(selectedProvider, "voice", customModel)} onClick={() => { setDraftModel(customModel.trim()); save(providerId, customModel.trim()); }}>{saving ? "Saving…" : "Apply"}</button></div> : null}
        {draftProvider !== null && !modelId && !custom ? <p className="voiceSettings__help">Choose a model to apply this provider.</p> : null}
      </> : <p className="voiceSettings__help">Talk and Chat follow {catalog?.current?.model || "your primary Hermes model"}, with the same tools and memory.</p>}
      <p className="voiceSettings__help">{providerId ? "This selection pins the model for Talk and Chat. Choose Hermes default to allow Jev model routing." : "When Jev model routing is enabled, it may select a compatible configured fallback for each prompt."}</p>
      {saveError ? <p className="voiceSettings__inlineError" role="alert">{saveError}</p> : null}
      {error ? <p className="voiceSettings__inlineError" role="alert">{error}</p> : null}
      <div className="voiceSettings__modelLinks"><button type="button" onClick={() => load(true)} disabled={loading || refreshing}>{refreshing ? "Refreshing…" : "Refresh models"}</button><Link href="/models">Browse all providers ↗</Link></div>
    </div>
  );
}
