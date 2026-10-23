"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const { preferences, updatePreferences, reducedMotion, palette } = useInterfacePreferences();
  const router = useRouter();
  const pathname = usePathname();
  const dialog = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState("");
  const collapsed = preferences.sidebarCollapsed;
  const tooltipPrefix = useId().replace(/:/g, "");
  const [tooltip, setTooltip] = useState(null);
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
      if (event.key === "Escape") setTooltip(null);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        if (event.repeat) return;
        const target = event.target;
        const editable = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
        if (editable || document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
        event.preventDefault();
        updatePreferences({ sidebarCollapsed: !preferences.sidebarCollapsed });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preferences.sidebarCollapsed, updatePreferences]);
  useEffect(() => { setTooltip(null); }, [pathname, collapsed]);
  function showTooltip(target, id, label) {
    if (!collapsed) return;
    const bounds = target.getBoundingClientRect();
    const railRight = target.closest("aside")?.getBoundingClientRect().right || bounds.right;
    setTooltip({ id, label, left: Math.max(bounds.right, railRight) + 10, top: Math.max(18, Math.min(window.innerHeight - 18, bounds.top + bounds.height / 2)) });
  }
  const tooltipEvents = (id, label) => ({
    onPointerEnter: event => showTooltip(event.currentTarget, id, label),
    onPointerLeave: () => setTooltip(null),
    onFocus: event => {
      const target = event.currentTarget;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (document.activeElement === target) showTooltip(target, id, label);
      }));
    },
    onBlur: () => setTooltip(null),
  });
  const matches = [...destinations, ...tabs.filter(tab => tab.published && !tab.archivedAt).map(tab => ({ key: tab.id, label: tab.title, href: `/workspace/${tab.id}`, icon: PanelTop }))].filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
  function navLink(item) {
    const Icon = item.icon;
    const tooltipId = `${tooltipPrefix}-${item.key}-tooltip`;
    return <Link key={item.key} href={item.href} prefetch={false} className={`controlNav__link${active === item.key ? " is-current" : ""}`} aria-current={active === item.key ? "page" : undefined} aria-label={collapsed ? item.label : undefined} aria-describedby={collapsed ? tooltipId : undefined} {...tooltipEvents(tooltipId, item.label)}>
      <Icon size={17} strokeWidth={1.6} aria-hidden="true" /><span className="controlNav__label">{item.label}</span>
    </Link>;
  }
  return <>
    <aside className={`controlNav${collapsed ? " is-collapsed" : ""}`} aria-label="Panel sections" onScroll={() => setTooltip(null)}>
      <div className="controlNav__brand"><Link href="/" aria-label="Panel Talk"><i className="controlNav__orb" aria-hidden="true"><HeroThinkingOrb state="breathing" paused={reducedMotion} speed={1} reducedMotion={reducedMotion} color={palette.color} nominalSize={20} /></i><span>panel<span className="controlNav__edition">LOCAL WORKSPACE</span></span></Link>
        <button className="iconButton collapseControl" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-describedby={collapsed ? `${tooltipPrefix}-collapse-tooltip` : undefined} aria-pressed={collapsed} onClick={() => updatePreferences({ sidebarCollapsed: !collapsed })} {...tooltipEvents(`${tooltipPrefix}-collapse-tooltip`, collapsed ? "Expand sidebar" : "Collapse sidebar")}>{collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}</button>
      </div>
      <button className="controlSearch" onClick={openSearch} aria-label="Search destinations" aria-describedby={collapsed ? `${tooltipPrefix}-search-tooltip` : undefined} {...tooltipEvents(`${tooltipPrefix}-search-tooltip`, "Search destinations")}><Search size={15} aria-hidden="true" /><span>Go to…</span><kbd>⌘ K</kbd></button>
      <nav className="controlNav__primary" aria-label="Workspace navigation"><div className={tabStyles.heading}><span className="navSectionLabel">WORKSPACE</span><button onClick={event => { event.currentTarget.focus(); setPlanner({ id: null }); }} aria-label="Create a workspace tab" aria-describedby={collapsed ? `${tooltipPrefix}-create-tooltip` : undefined} {...tooltipEvents(`${tooltipPrefix}-create-tooltip`, "Create a workspace tab")}><Plus size={15} aria-hidden="true" /></button></div>{destinations.slice(0, 6).map(navLink)}{tabs.filter(tab => !tab.archivedAt).map(tab => { const tooltipId = `${tooltipPrefix}-tab-${tab.id}-tooltip`; const tooltipLabel = tab.published ? tab.title : `Continue planning ${tab.title}`; return tab.published ? <Link key={tab.id} href={`/workspace/${tab.id}`} prefetch={false} className={`controlNav__link${pathname === `/workspace/${tab.id}` ? " is-current" : ""}`} aria-current={pathname === `/workspace/${tab.id}` ? "page" : undefined} aria-label={collapsed ? tab.title : undefined} aria-describedby={collapsed ? tooltipId : undefined} {...tooltipEvents(tooltipId, tooltipLabel)}><PanelTop size={17} strokeWidth={1.6} aria-hidden="true" /><span className="controlNav__label">{tab.title}</span></Link> : <button key={tab.id} className={`controlNav__link ${tabStyles.draft}`} onClick={event => { event.currentTarget.focus(); setPlanner({ id: tab.id }); }} aria-label={collapsed ? tooltipLabel : undefined} aria-describedby={collapsed ? tooltipId : undefined} {...tooltipEvents(tooltipId, tooltipLabel)}><FilePenLine size={17} strokeWidth={1.6} aria-hidden="true" /><span className="controlNav__label">{tab.title}<small>Draft</small></span></button>; })}{tabsError && <button className={tabStyles.retry} onClick={refreshTabs}>{tabsError} Retry</button>}</nav>
      <nav className="controlNav__config" aria-label="Agent settings"><span className="navSectionLabel">CONFIGURATION</span>{destinations.slice(6).map(navLink)}</nav>
      <details className={tabStyles.mobileConfig}><summary><Settings size={15} />Configuration</summary><nav aria-label="Mobile configuration">{destinations.slice(6).map(item => <Link key={item.key} href={item.href} prefetch={false} className="controlNav__link" data-current={active === item.key || undefined} aria-current={active === item.key ? "page" : undefined}><item.icon size={17} strokeWidth={1.6} /><span>{item.label}</span></Link>)}</nav></details>
      <div className="controlNav__bottom"><Link href="/tools?view=runtime" prefetch={false} className="connectionCard"><span className="statusDot" data-tone={runtime?.error ? "warning" : runtime?.snapshot ? "online" : "muted"} /><span><strong>{runtime?.error ? "Updates interrupted" : !runtime?.snapshot ? "Checking Panel" : "Local workspace"}</strong><small>{runtime?.error ? "Reconnecting automatically" : "Runs on your Mac"}</small></span><ArrowUpRight size={14} /></Link>
      <div className="controlNav__signature"><span>P</span><div><strong>Panel</strong><small>Local workspace</small></div></div></div>
    </aside>
    <dialog ref={dialog} className="commandDialog" aria-label="Go to a workspace section" onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}>
      <form onSubmit={event => { event.preventDefault(); if (matches[0]) { dialog.current.close(); router.push(matches[0].href); } }}>
        <div className="commandDialog__search"><Search size={19} /><input ref={searchRef} aria-label="Find a destination" placeholder="Where would you like to go?" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" onClick={() => dialog.current.close()}>Esc</button></div>
        <div className="commandDialog__results">{matches.map(item => <Link key={item.key} href={item.href} onClick={() => dialog.current.close()}><item.icon size={17} />{item.label}<ArrowUpRight size={14} /></Link>)}{!matches.length && <p>No matching destinations.</p>}</div>
        <footer><Command size={12} /> Quick navigation <span>Enter opens the first result</span></footer>
      </form>
    </dialog>
    {collapsed && tooltip && typeof document !== "undefined" ? createPortal(<span className="controlNav__tooltip" id={tooltip.id} role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.label}</span>, document.body) : null}
    {planner && <WorkspaceTabPlanner key={planner.id || "new"} initialId={planner.id} savedTabs={tabs} onClose={() => { setPlanner(null); refreshTabs(); }} onChanged={refreshTabs} />}
  </>;
}
