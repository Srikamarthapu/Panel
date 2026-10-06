"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, GitBranch, Zap } from "lucide-react";
import styles from "./JevRouterSettings.module.css";

const defaults = { enabled: false, discordEnabled: false, modelRouting: false, toolSelection: true, directDispatch: true, monitorProgress: true, manageContext: true };
const options = [
  { key: "discordEnabled", title: "Use Jev for Discord", description: "Evaluate each Discord turn and tool step inside the Hermes gateway." },
  { key: "modelRouting", title: "Choose a model for default Discord and Control prompts", description: "Choose among the configured default model and same-provider fallbacks. Talk/Chat routes only when Conversation provider is ‘Follow Hermes primary model’; saved model picks and Discord /model overrides stay in effect." },
  { key: "toolSelection", title: "Choose the next tool at each step", description: "Jev evaluates the current conversation and available tools throughout the Hermes loop." },
  { key: "directDispatch", title: "Run ready read-only actions", description: "Skip a frontier-model call for supported read-only tools with complete, known arguments. Hermes writes open-ended commands and content." },
  { key: "monitorProgress", title: "Detect repeated failures", description: "Give Hermes feedback when the same approach keeps failing, so it can change course." },
  { key: "manageContext", title: "Keep useful tool context", description: "Keep, shorten, or omit old tool output from supported model requests. Your saved conversation stays intact." },
];

function settingsFrom(status) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof status?.[key] === "boolean" ? status[key] : fallback]));
}
function count(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value).toLocaleString() : "—"; }
function milliseconds(value) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? `${Math.round(number).toLocaleString()} ms` : "—";
}
function decisionLabel(decision) {
  const mode = String(decision?.mode || decision?.action || decision?.kind || "").toLowerCase();
  if (mode === "model") return "Selected a model";
  if (/direct|dispatch|execute/.test(mode)) return "Dispatched a tool directly";
  if (mode === "finish") return "Ready for Hermes to answer";
  if (/fallback|defer|error|unavailable/.test(mode)) return "Continued with Hermes";
  if (/compact|context/.test(mode)) return "Compacted tool context";
  if (/repeat|stuck|monitor/.test(mode)) return "Reviewed the run's progress";
  if (/forc|select|tool/.test(mode)) return "Selected a tool for Hermes";
  return "Latest tool decision";
}
function reasonLabel(reason) {
  return ({ uncertain_selection: "Jev did not return a selection safe enough to override Hermes", below_confidence: "Jev's selection was below the configured confidence threshold", diffuse_selection: "Jev's probability was spread too widely to override Hermes", invalid_choice_schema: "TypeSafe returned an unexpected Choice shape", unknown_choice: "TypeSafe returned an option outside the advertised tool list", missing_confidence: "TypeSafe did not return a valid confidence value", incomplete_probabilities: "TypeSafe did not return probabilities for every advertised option", invalid_probabilities: "TypeSafe returned invalid probability values", inconsistent_selection: "TypeSafe's selected option did not match its probability distribution", needs_hermes_reasoning: "Hermes needed to reason about the next step", compose_final_answer: "Jev found the tool work complete", hermes_fills_arguments: "Jev chose the tool and Hermes prepared its inputs", grounded_read_arguments: "Jev chose a ready read-only action", progress_checked: "Jev reviewed progress and kept Hermes in control", reconsider_failed_strategy: "Jev flagged a repeated approach", tools_required_by_host: "The host required Hermes tool routing", provider_thinking_requires_auto: "Provider thinking mode requires automatic tool routing, so Jev evaluated the step and deferred to Hermes" })[reason] || "";
}

export default function JevRouterSettings() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(defaults);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const mutationEpoch = useRef(0);

  const acceptStatus = useCallback((data, force = false) => {
    setStatus(data);
    setLoadError(false);
    if (force || !dirtyRef.current) setSettings(settingsFrom(data));
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer;
    let controller;
    let refreshing = false;
    async function refresh() {
      clearTimeout(timer);
      if (stopped) return;
      if (document.hidden || busyRef.current || refreshing) { timer = setTimeout(refresh, 5000); return; }
      refreshing = true;
      controller = new AbortController();
      const requestEpoch = mutationEpoch.current;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch("/api/models/router", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Jev status is unavailable.");
        const data = await response.json();
        if (!stopped && requestEpoch === mutationEpoch.current) acceptStatus(data);
      } catch {
        if (!stopped && requestEpoch === mutationEpoch.current) setLoadError(true);
      } finally {
        clearTimeout(timeout);
        refreshing = false;
        if (!stopped) timer = setTimeout(refresh, 5000);
      }
    }
    function onVisibility() {
      clearTimeout(timer);
      if (!document.hidden) refresh();
    }
    refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [acceptStatus]);

  function changeSetting(key, value) {
    dirtyRef.current = true;
    setDirty(true);
    setSettings(current => ({ ...current, [key]: value }));
    setNotice(null);
  }
  function changeKey(value) {
    dirtyRef.current = true;
    setDirty(true);
    setApiKey(value);
    setNotice(null);
  }
  async function save(removeKey = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    mutationEpoch.current += 1;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/models/router", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(removeKey ? { enabled: false, removeKey: true } : { ...settings, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save Jev settings.");
      dirtyRef.current = false;
      setDirty(false);
      acceptStatus(data, true);
      setApiKey("");
      setNotice({ error: false, text: removeKey ? "Saved key removed. Jev is off." : data.enabled ? "Saved. Your next Hermes request will use these Jev settings." : "Saved. Hermes will run with Jev off." });
    } catch (error) { setNotice({ error: true, text: error.message }); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const runtime = status?.runtime;
  const metrics = runtime?.metrics;
  const decision = runtime?.lastDecision;
  const decisionTool = decision?.selectedModel || decision?.tool || decision?.toolName || decision?.tool_name;
  const decisionTime = decision?.decisionMs ?? decision?.latencyMs ?? decision?.elapsedMs ?? decision?.duration_ms;
  const connected = !!status?.configured;
  const installed = runtime?.installed === true;
  const needsDiscordModelRoute = !!(status?.enabled && status?.discordEnabled && status?.modelRouting && runtime?.discordModelRouteInstalled !== true);
  const active = connected && status?.enabled && installed && !needsDiscordModelRoute;
  const statusLabel = !status ? loadError ? "Status unavailable" : "Connecting…" : !connected ? "Add an API key" : !status.enabled ? "Off" : !installed ? "Runtime unavailable" : needsDiscordModelRoute ? "Discord model hook missing" : "Configured";
  const hasDecisions = Number(metrics?.decisions) > 0;
  const tracksProviderCalls = Boolean(runtime?.providerTrackingSince);

  return <section className={styles.card} aria-labelledby="jev-heading">
    <header className={styles.heading}><div className={styles.identity}><span className={styles.icon}><GitBranch size={20} /></span><div><span className={styles.eyebrow}>Tool execution</span><h2 id="jev-heading">Jev inside Hermes</h2></div></div><span className={styles.status} data-active={active || undefined}>{active && <Check size={12} />}{statusLabel}</span></header>
    <p className={styles.intro}>Jev chooses the next tool throughout a request. Supported read-only actions with known arguments go straight to execution. Hermes handles reasoning, open-ended arguments, and your final answer.</p>

    <form onSubmit={event => { event.preventDefault(); save(); }}>
      <fieldset disabled={busy} className={styles.fields}>
        <label className={styles.master}><span><strong>Use Jev inside Hermes</strong><small>Applies to new requests in Talk, Chat, and enabled Discord sessions</small></span><input type="checkbox" role="switch" checked={settings.enabled} onChange={event => changeSetting("enabled", event.target.checked)} /><span className={styles.switchTrack} aria-hidden="true" /></label>
        <div className={styles.options}>{options.map(option => <label className={styles.option} key={option.key}><input type="checkbox" checked={settings[option.key]} onChange={event => changeSetting(option.key, event.target.checked)} /><span><strong>{option.title}</strong><small>{option.description}</small></span></label>)}</div>
        <label className={styles.key}><span>{connected ? "Replace TypeSafe API key" : "TypeSafe API key"}</span><input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => changeKey(event.target.value)} placeholder={connected ? "Leave blank to keep the current key" : "Paste your TypeSafe API key"} /></label>
        {connected && status?.keySource !== "saved" && <p className={styles.keySource}>Hermes is using a key from its environment. Leave this field blank to keep using it.</p>}
        {connected && status?.keySuffix && <p className={styles.keySource}>Active TypeSafe key ends in <code>…{status.keySuffix}</code>.</p>}
      </fieldset>
      <p className={styles.note}>When enabled, relevant recent conversation, tool summaries, and the tool inventory are sent to TypeSafe. Model routing also sends the current Control or Discord prompt. Other provider keys stay on this Mac. Hermes's existing permissions still apply to tool execution.</p>
      <div className={styles.actions}><button type="submit" disabled={busy || !status || (settings.enabled && !connected && !apiKey.trim())}>{busy ? "Saving…" : "Save settings"}</button><a href="https://console.typesafe.ai" target="_blank" rel="noreferrer">TypeSafe console <ArrowUpRight size={13} /></a>{status?.keySource === "saved" && <button type="button" className={styles.remove} disabled={busy} onClick={() => save(true)}>Remove saved key</button>}{dirty && <span className={styles.unsaved}>Unsaved changes</span>}</div>
    </form>

    {notice && <p className={notice.error ? styles.error : styles.notice} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {needsDiscordModelRoute && <p className={styles.note} role="status">Discord model routing needs the Hermes gateway hook. Run <code>scripts/voice/install-jev-discord-route.py</code> after installing or updating Hermes.</p>}
    <section className={styles.runtime} aria-label="Measured Jev activity"><div className={styles.runtimeHeading}><span><Zap size={14} />Runtime activity</span><small>{loadError ? "Updates interrupted" : !status ? "Checking runtime…" : installed ? `Installed${runtime.version ? ` · ${runtime.version}` : ""}` : "Not installed"}</small></div>
      <div className={styles.metrics}><div><strong>{tracksProviderCalls ? count(metrics?.providerSuccesses) : "—"}</strong><span>Provider responses</span></div><div><strong>{count(metrics?.decisions)}</strong><span>Measured evaluations</span></div><div><strong>{count(metrics?.forced)}</strong><span>Tools selected for Hermes</span></div><div><strong>{hasDecisions ? milliseconds(metrics?.averageDecisionMs) : "—"}</strong><span>Average Jev evaluation</span></div></div>
      {decision ? <div className={styles.lastDecision}><div><span>{decisionLabel(decision)}</span>{typeof decisionTool === "string" && <code>{decisionTool}</code>}</div><small>{milliseconds(decisionTime)}</small></div> : <p className={styles.emptyActivity}>{installed ? "Measured activity will appear after Jev handles a request." : "The Jev middleware needs to be installed in Hermes before it can run."}</p>}
      {hasDecisions && <p className={styles.runtimeNote}>{count(metrics?.fallback)} {Number(metrics?.fallback) === 1 ? "step continued" : "steps continued"} with Hermes fallback. These counts reflect actual runtime decisions.</p>}
      {decision?.reason && <p className={styles.runtimeNote}>{reasonLabel(decision.reason)}</p>}
      {tracksProviderCalls && <p className={styles.runtimeNote}>Cumulative on this Mac since tracking began and possibly across key changes: {count(metrics?.providerAttempts)} calls attempted · {count(metrics?.providerSuccesses)} valid responses{Number(metrics?.providerFailures) > 0 ? ` · ${count(metrics.providerFailures)} failed` : ""}{Number(metrics?.providerTimeouts) > 0 ? ` · ${count(metrics.providerTimeouts)} timed out locally` : ""}.</p>}
      {(status?.model || status?.timeoutMs) && <div className={styles.runtimeMeta}>{status.model && <span>Model <code>{status.model}</code></span>}{status.timeoutMs && <span>Decision timeout {milliseconds(status.timeoutMs)}</span>}</div>}
    </section>
    {status?.coolingDown && <p className={styles.note}>TypeSafe is temporarily unavailable. Hermes is handling tool decisions while Jev reconnects.</p>}
  </section>;
}
