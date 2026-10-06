"use client";
import { useEffect, useState } from "react";
import { BookOpen, Plug, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { workRequest } from "./WorkSessionProvider.jsx";

export default function ToolsWorkspace() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("skills");
  async function refresh() {
    setLoading(true); setError("");
    try { setData(await workRequest("/api/capabilities")); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (new URLSearchParams(window.location.search).get("view") === "runtime") setView("runtime"); void refresh(); }, []);
  const rows = (Array.isArray(data?.[view]) ? data[view] : []).filter(row => `${row.name} ${row.description} ${row.category || ""}`.toLowerCase().includes(query.toLowerCase()));
  const Icon = view === "plugins" ? Plug : BookOpen;
  return <section className="workPage">
    <header className="workPage__heading"><div><span className="workEyebrow">AGENT CAPABILITIES</span><h1>What your agent works with.</h1><p>Skills give it a method. Plugins connect it to tools. See what’s installed in your Hermes environment.</p></div><button className="workButton workButton--quiet" disabled={loading} onClick={refresh}><RefreshCw size={14} />{loading ? "Reading…" : "Refresh"}</button></header>
    <div className="workTabs" aria-label="Capability views">{["skills", "plugins", "runtime"].map(key => <button key={key} aria-pressed={view === key} onClick={() => { setView(key); setQuery(""); }}>{key === "skills" ? "Skills" : key === "plugins" ? "Plugins" : "Runtime"}{key !== "runtime" && data && <span>{data[key]?.length || 0}</span>}</button>)}</div>
    {error && <p className="workError" role="alert">{error}</p>}
    {data?.warnings?.map(warning => <p className="workNotice" key={warning}>{warning}</p>)}
    {view === "runtime" ? <><dl className="runtimeFacts"><div><dt>Agent runtime</dt><dd>Hermes Agent</dd></div><div><dt>Configuration</dt><dd>{data ? data.runtime?.configurationFound ? "Found" : "Not found · Run hermes setup" : "Checking…"}</dd></div><div><dt>Python environment</dt><dd>{data ? data.runtime?.environmentFound ? "Found · Use the doctor to verify compatibility" : "Not found · Set HERMES_REPO" : "Checking…"}</dd></div><div><dt>Hermes home</dt><dd>{data?.runtime?.home || "—"}</dd></div><div><dt>Runtime folder</dt><dd>{data?.runtime?.repository || "—"}</dd></div><div><dt>Local diagnostics</dt><dd><code>npm run doctor</code></dd></div></dl><p className="workHelp">Chat runs through the Hermes CLI. The Discord gateway does not need to be running. Configure your providers in Hermes; choose your working model in <Link href="/models">Models</Link>.</p></> : <>
      <div className="workList__toolbar"><label className="workSearch"><Search size={16} /><input type="search" aria-label={`Search ${view}`} placeholder={`Find ${view}…`} value={query} onChange={event => setQuery(event.target.value)} /></label><span>{rows.length} {view}</span></div>
      <div className="capabilityList">{rows.map(row => <article className="capabilityRow" key={row.id}><Icon size={19} strokeWidth={1.5} /><div className="capabilityRow__body"><h2>{row.name}</h2><p>{row.description || "No description in this manifest."}</p><small>{row.source}{row.category ? ` · ${row.category}` : ""}{row.version ? ` · v${row.version}` : ""}</small></div>{view === "plugins" && <span className="workTag">{row.status}</span>}</article>)}</div>
      {!loading && !error && !rows.length && <div className="workEmpty"><h2>{query ? "No matches" : `No ${view} found`}</h2><p>{query ? "Try a different name or description." : `Add ${view} through Hermes, then refresh this inventory.`}</p></div>}
      {loading && !data && <p className="workNotice" role="status">Reading local manifests…</p>}
      <p className="workHelp" style={{ marginTop: 24 }}>{data?.scope || "This is a read-only view of your local installation."}</p>
    </>}
  </section>;
}
