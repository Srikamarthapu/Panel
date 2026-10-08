"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { MessageSquare, SquareCheck, Folder, Brain, Cpu, AudioLines, Mic, Wrench, Settings, Search, PanelLeftClose, PanelLeftOpen, ArrowUpRight, Command, Users, Plus, PanelTop, FilePenLine } from "lucide-react";
import { HeroThinkingOrb } from "@/components/MissionOrb.jsx";
import { useRuntime } from "@/components/control/RuntimeProvider.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import WorkspaceTabPlanner from "@/components/workspace/WorkspaceTabPlanner.jsx";
import tabStyles from "@/components/workspace/WorkspaceTabNavigation.module.css";

export const destinations = [
  { key: "overview", label: "Talk", href: "/", icon: AudioLines },
  { key: "chat", label: "Chat", href: "/chat", icon: MessageSquare },
  { key: "tasks", label: "Tasks", href: "/tasks", icon: SquareCheck },
  { key: "sessions", label: "Sessions", href: "/sessions", icon: Folder },
  { key: "agents", label: "Agents", href: "/agents", icon: Users },
  { key: "memory", label: "Memory", href: "/memory", icon: Brain },
  { key: "models", label: "Models", href: "/models", icon: Cpu },
  { key: "tools", label: "Tools", href: "/tools", icon: Wrench },
  { key: "voice", label: "Voice settings", href: "/voice", icon: Mic },
  { key: "settings", label: "Settings", href: "/settings", icon: Settings },
];

export default function TabRail({ active }) {
  const runtime = useRuntime();
  const { reducedMotion, palette } = useInterfacePreferences();
  const router = useRouter();
  const pathname = usePathname();
  const dialog = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [tabs, setTabs] = useState([]), [planner, setPlanner] = useState(null), [tabsError, setTabsError] = useState("");
  const tabLoad = useRef(0), navMounted = useRef(true);
  async function refreshTabs() {
    const sequence = ++tabLoad.current;
    try {
      const response = await fetch("/api/workspace-tabs?archived=true", { cache: "no-store" });
      if (!response.ok) throw new Error("Tabs unavailable");
      const result = await response.json();
      if (navMounted.current && sequence === tabLoad.current) { setTabs(result.tabs || []); setTabsError(""); }
    } catch { if (navMounted.current && sequence === tabLoad.current) setTabsError("Saved tabs couldn’t load."); }
  }
  useEffect(() => {
    navMounted.current = true; refreshTabs();
    const open = event => { if (typeof event.detail?.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(event.detail.id)) setPlanner({ id: event.detail.id }); };
    const refresh = () => refreshTabs();
    window.addEventListener("panel:edit-workspace-tab", open);
    window.addEventListener("panel:workspace-tabs-changed", refresh);
    return () => { navMounted.current = false; tabLoad.current++; window.removeEventListener("panel:edit-workspace-tab", open); window.removeEventListener("panel:workspace-tabs-changed", refresh); };
  }, []);
  function openSearch() { setQuery(""); dialog.current?.showModal(); searchRef.current?.focus(); }
  useEffect(() => {
    function onKey(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const matches = [...destinations, ...tabs.filter(tab => tab.published && !tab.archivedAt).map(tab => ({ key: tab.id, label: tab.title, href: `/workspace/${tab.id}`, icon: PanelTop }))].filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
  function navLink(item) {
    const Icon = item.icon;
    return <Link key={item.key} href={item.href} prefetch={false} className={`controlNav__link${active === item.key ? " is-current" : ""}`} aria-current={active === item.key ? "page" : undefined} title={collapsed ? item.label : undefined}>
      <Icon size={17} strokeWidth={1.6} /><span>{item.label}</span>
    </Link>;
  }
  return <>
    <aside className={`controlNav${collapsed ? " is-collapsed" : ""}`} aria-label="Panel sections">
      <div className="controlNav__brand"><Link href="/" aria-label="Panel Talk"><i className="controlNav__orb" aria-hidden="true"><HeroThinkingOrb state="breathing" paused={reducedMotion} speed={1} reducedMotion={reducedMotion} color={palette.color} nominalSize={20} /></i><span>panel<span className="controlNav__edition">LOCAL WORKSPACE</span></span></Link>
        <button className="iconButton collapseControl" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      </div>
      <button className="controlSearch" onClick={openSearch} aria-label="Search destinations"><Search size={15} /><span>Go to…</span><kbd>⌘ K</kbd></button>
      <nav className="controlNav__primary" aria-label="Workspace navigation"><div className={tabStyles.heading}><span className="navSectionLabel">WORKSPACE</span><button onClick={event => { event.currentTarget.focus(); setPlanner({ id: null }); }} aria-label="Create a workspace tab" title="Create a workspace tab"><Plus size={15} /></button></div>{destinations.slice(0, 6).map(navLink)}{tabs.filter(tab => !tab.archivedAt).map(tab => tab.published ? <Link key={tab.id} href={`/workspace/${tab.id}`} prefetch={false} className={`controlNav__link${pathname === `/workspace/${tab.id}` ? " is-current" : ""}`} aria-current={pathname === `/workspace/${tab.id}` ? "page" : undefined} title={tab.title}><PanelTop size={17} strokeWidth={1.6} /><span>{tab.title}</span></Link> : <button key={tab.id} className={`controlNav__link ${tabStyles.draft}`} onClick={event => { event.currentTarget.focus(); setPlanner({ id: tab.id }); }} title={`Continue planning ${tab.title}`}><FilePenLine size={17} strokeWidth={1.6} /><span>{tab.title}<small>Draft</small></span></button>)}{tabsError && <button className={tabStyles.retry} onClick={refreshTabs}>{tabsError} Retry</button>}</nav>
      <nav className="controlNav__config" aria-label="Agent settings"><span className="navSectionLabel">CONFIGURATION</span>{destinations.slice(6).map(navLink)}</nav>
      <details className={tabStyles.mobileConfig}><summary><Settings size={15} />Configuration</summary><nav aria-label="Mobile configuration">{destinations.slice(6).map(item => <Link key={item.key} href={item.href} prefetch={false} className="controlNav__link" data-current={active === item.key || undefined} aria-current={active === item.key ? "page" : undefined}><item.icon size={17} strokeWidth={1.6} /><span>{item.label}</span></Link>)}</nav></details>
      <div className="controlNav__bottom"><Link href="/tools?view=runtime" prefetch={false} className="connectionCard"><span className="statusDot" data-tone={runtime?.error ? "warning" : runtime?.snapshot ? "online" : "muted"} /><span><strong>{runtime?.error ? "Updates interrupted" : !runtime?.snapshot ? "Checking Panel" : "Local workspace"}</strong><small>{runtime?.error ? "Reconnecting automatically" : "Runs on your Mac"}</small></span><ArrowUpRight size={14} /></Link>
      <div className="controlNav__signature"><span>P</span><div><strong>Panel</strong><small>Powered by Hermes</small></div></div></div>
    </aside>
    <dialog ref={dialog} className="commandDialog" aria-label="Go to a workspace section" onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}>
      <form onSubmit={event => { event.preventDefault(); if (matches[0]) { dialog.current.close(); router.push(matches[0].href); } }}>
        <div className="commandDialog__search"><Search size={19} /><input ref={searchRef} aria-label="Find a destination" placeholder="Where would you like to go?" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" onClick={() => dialog.current.close()}>Esc</button></div>
        <div className="commandDialog__results">{matches.map(item => <Link key={item.key} href={item.href} onClick={() => dialog.current.close()}><item.icon size={17} />{item.label}<ArrowUpRight size={14} /></Link>)}{!matches.length && <p>No matching destinations.</p>}</div>
        <footer><Command size={12} /> Quick navigation <span>Enter opens the first result</span></footer>
      </form>
    </dialog>
    {planner && <WorkspaceTabPlanner key={planner.id || "new"} initialId={planner.id} savedTabs={tabs} onClose={() => { setPlanner(null); refreshTabs(); }} onChanged={refreshTabs} />}
  </>;
}
