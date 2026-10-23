"use client";

import { useEffect, useMemo, useState } from "react";

const EMPTY = { executionMode: "hermes", provider: "", model: "", ready: false, providers: [] };

export default function DirectConnectionSettings() {
  const [config, setConfig] = useState(EMPTY);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const selected = useMemo(() => config.providers.find(item => item.id === provider), [config.providers, provider]);

  useEffect(() => {
    let active = true;
    fetch("/api/direct/config", { cache: "no-store" }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      if (active) { setConfig(value.config); setProvider(value.config.provider || value.config.providers[0]?.id || ""); setModel(value.config.model || ""); }
    }).catch(() => active && setError("Direct connection settings could not be loaded.")).finally(() => active && setBusy(""));
    return () => { active = false; };
  }, []);

  async function save(patch, message) {
    setBusy("save"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/direct/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Settings could not be saved.");
      setConfig(value.config); setApiKey(""); setNotice(message);
      window.dispatchEvent(new Event("panel-runtime-changed"));
      return true;
    } catch (failure) { setError(failure.message); return false; }
    finally { setBusy(""); }
  }

  async function loadModels() {
    if (!provider) { setError("Choose a provider first."); return; }
    setBusy("models"); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/direct/models?provider=${encodeURIComponent(provider)}`, { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Models could not be loaded.");
      setModels(value.models || []); setNotice(`Loaded ${value.models?.length || 0} models from the provider.`);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  }

  async function saveKey(event) {
    event.preventDefault();
    if (!apiKey.trim()) { setError("Enter an API key first."); return; }
    const saved = await save({ credentialProvider: provider, apiKey }, `${selected?.label || "Provider"} key saved on this device.`);
    if (saved) await loadModels();
  }

  const direct = config.executionMode === "direct";
  const keyHelp = selected?.configured
    ? `${selected.label} already has a ${selected.keySource === "environment" ? "key in the environment" : "saved key"}. Enter another only to replace it.`
    : "Enter a key to enable Save key.";
  const modelHelp = selected?.configured
    ? models.length ? "Choose a fetched model or enter an exact provider model ID." : "Load the provider catalog, or enter an exact model ID."
    : `Save a ${selected?.label || "provider"} key before loading models.`;
  return <section className="directConnection" aria-labelledby="direct-connection-heading" aria-busy={Boolean(busy)}>
    <div className="directConnection__heading"><div><span className="workEyebrow">EXECUTION</span><h2 id="direct-connection-heading">Choose how Panel answers.</h2></div><span className={`directConnection__status ${direct ? "isDirect" : ""}`}>{direct ? "Direct API" : "Hermes"}</span></div>
    <p className="directConnection__intro">Hermes includes the full local agent runtime and tools. Direct API provides streaming chat, saved history, and teammate roles, without tools, files, web access, delegation, or workspace planning.</p>
    <div className="directConnection__mode" role="group" aria-label="Execution mode">
      <button type="button" aria-pressed={!direct} disabled={Boolean(busy)} onClick={() => save({ executionMode: "hermes" }, "Hermes will handle new requests.")}><strong>Hermes</strong><span>Local agent runtime and tools</span></button>
      <button type="button" aria-pressed={direct} disabled={Boolean(busy) || !config.ready} onClick={() => save({ executionMode: "direct" }, "Direct API mode will handle new requests.")}><strong>Direct API</strong><span>{config.ready ? "Use the saved direct route" : "Connect a model below first"}</span></button>
    </div>
    <div className="directConnection__setup" aria-label="Direct provider connection">
      <form className="directConnection__form" onSubmit={saveKey}>
        <div className="directConnection__field">
          <label id="direct-provider-label" htmlFor="direct-provider">Provider</label>
          <select id="direct-provider" aria-labelledby="direct-provider-label" aria-describedby="direct-provider-help" value={provider} disabled={Boolean(busy)} onChange={event => { setProvider(event.target.value); setModel(""); setModels([]); setNotice(""); setError(""); }}>{config.providers.map(item => <option key={item.id} value={item.id}>{item.label}{item.configured ? item.keySource === "environment" ? " · environment key" : " · key saved" : ""}</option>)}</select>
          <small id="direct-provider-help">Choose the provider that issued this key.</small>
        </div>
        <div className="directConnection__field">
          <label id="direct-api-key-label" htmlFor="direct-api-key">API key</label>
          <input id="direct-api-key" aria-labelledby="direct-api-key-label" aria-describedby="direct-api-key-help" type="password" autoComplete="off" value={apiKey} disabled={Boolean(busy)} placeholder={selected?.configured ? "Saved — enter a new key to replace" : "Stored only on this device"} onChange={event => setApiKey(event.target.value)} />
          <small id="direct-api-key-help">{keyHelp}</small>
        </div>
        <div className="directConnection__actions"><button type="submit" className="workButton" disabled={Boolean(busy) || !provider || !apiKey.trim()}>{busy === "save" ? "Saving…" : "Save key"}</button>{selected?.keySource === "saved" && <button type="button" className="workButton workButton--quiet" disabled={Boolean(busy)} onClick={() => save({ credentialProvider: provider, clearKey: true, ...(direct && config.provider === provider ? { executionMode: "hermes" } : {}) }, `${selected.label} key removed.`)}>Remove key</button>}</div>
      </form>
      <div className="directConnection__model">
        <div className="directConnection__field">
          <label id="direct-model-label" htmlFor="direct-model">Model ID</label>
          <input id="direct-model" aria-labelledby="direct-model-label" aria-describedby="direct-model-help" list="direct-models" value={model} disabled={Boolean(busy)} placeholder="Load the provider catalog" onChange={event => setModel(event.target.value)} />
          <small id="direct-model-help">{modelHelp}</small>
          <datalist id="direct-models">{models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</datalist>
        </div>
        <div className="directConnection__actions"><button type="button" className="workButton workButton--quiet" disabled={Boolean(busy) || !selected?.configured} onClick={loadModels}>{busy === "models" ? "Loading…" : "Load models"}</button><button type="button" className="workButton" disabled={Boolean(busy) || !selected?.configured || !provider || !model.trim()} onClick={() => save({ executionMode: "direct", provider, model }, "This direct model will handle new requests.")}>Use this model</button></div>
      </div>
      <p className="directConnection__privacy">Keys are stored privately on this device and are not shown again. Panel sends each key only to its provider.</p>
    </div>
    <div id="direct-connection-feedback" className="directConnection__feedback" role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"}>{error ? <span className="isError">{error}</span> : <span>{notice}</span>}</div>
  </section>;
}
