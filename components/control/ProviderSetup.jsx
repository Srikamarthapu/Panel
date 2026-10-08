"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Plus, X } from "lucide-react";
import styles from "./ProviderSetup.module.css";

const command = "hermes model";
const docsUrl = "https://hermes-agent.nousresearch.com/docs/integrations/providers/";
const defaultDashboardUrl = "http://127.0.0.1:9119/models?profile=default";

function SetupDialog({ onClose, onRefresh }) {
  const dialog = useRef(null), heading = useRef(null), opening = useRef(false);
  const [dashboardUrl, setDashboardUrl] = useState(defaultDashboardUrl), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  useEffect(() => {
    const trigger = document.activeElement, modal = dialog.current;
    modal.showModal(); heading.current?.focus();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let cancelled = false;
    fetch("/api/models/setup", { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Could not read the dashboard address.");
      const data = await response.json();
      if (!cancelled) setDashboardUrl(data.dashboardUrl || defaultDashboardUrl);
    }).catch(() => { if (!cancelled) setError("Could not read your dashboard address. The link below uses Hermes’s default port, 9119."); })
      .finally(() => window.clearTimeout(timeout));
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); modal.close(); if (trigger?.isConnected) trigger.focus?.(); };
  }, []);
  async function openDashboard(event) {
    if (!window.__TAURI__) return; // Ordinary browsers follow the link.
    event.preventDefault(); // The native shell opens the system browser.
    if (opening.current) return;
    opening.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/models/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "open-dashboard" }), signal: AbortSignal.timeout(8000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The dashboard could not be opened.");
      setNotice("Dashboard opened in your browser. After updating providers, return here and refresh.");
    } catch (failure) { setError(failure.name === "TimeoutError" ? "Opening the dashboard took too long. Copy its address into your browser." : failure.message); }
    finally { opening.current = false; setBusy(false); }
  }
  async function copyCommand() {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { setError("Select the command below and copy it manually."); }
  }
  return <dialog ref={dialog} className={`sessionDialog ${styles.dialog}`} aria-labelledby="provider-setup-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2 ref={heading} tabIndex={-1} id="provider-setup-title">Providers &amp; API keys</h2><p>Connect accounts in Hermes. Choose how Panel uses them here.</p></div><button type="button" className="iconButton" aria-label="Close provider setup" onClick={onClose}><X size={18} /></button></header>
    <div className={styles.content}>
      <section><h3>Hermes dashboard</h3><p>Add providers and API keys, connect accounts, and manage models in Hermes’s Models page.</p>
        <a className="workButton" href={dashboardUrl} target="_blank" rel="noreferrer" aria-disabled={busy || undefined} onClick={openDashboard}>{busy ? "Opening…" : "Open Hermes dashboard"}<ArrowUpRight size={15} /></a>
        <code className={styles.address} tabIndex={0}>{dashboardUrl}</code>
        <p className={styles.hint}>If the page is unavailable, start it with <code>hermes dashboard</code> in a terminal, then open the link again.</p>
      </section>
      <section><h3>Terminal setup</h3><p>Run this command to choose a provider and enter its credentials.</p><div className={styles.command}><code tabIndex={0}>{command}</code><button type="button" className="iconButton" aria-label="Copy provider setup command" onClick={copyCommand}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>{copied && <span role="status" className={styles.hint}>Command copied</span>}
        <a href={docsUrl} target="_blank" rel="noreferrer" className={styles.docs}>Provider setup guide<ArrowUpRight size={14} /></a>
      </section>
      <p className={styles.hint}>API keys stay in Hermes. Refresh your connections after setup, then assign a main, backup, or conversation model in Panel.</p>
      {notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p role="alert" className="workError">{error}</p>}
    </div>
    <footer><button type="button" className="workButton workButton--quiet" onClick={onClose}>Done</button><button type="button" className="workButton" onClick={() => { onRefresh(); onClose(); }}>Refresh connections</button></footer>
  </dialog>;
}

export default function ProviderSetup({ onRefresh }) {
  const [open, setOpen] = useState(false);
  return <><div className={styles.bar}><div><strong>Providers &amp; API keys</strong><p>Add a connection or manage your existing accounts.</p></div><button type="button" className="workButton workButton--quiet" onClick={event => { event.currentTarget.focus(); setOpen(true); }}><Plus size={15} />Manage providers</button></div>{open && <SetupDialog onRefresh={onRefresh} onClose={() => setOpen(false)} />}</>;
}
