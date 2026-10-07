"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageSquare, SquareCheck, Folder, Brain, Cpu, AudioLines, Mic, Wrench, Settings, Search, PanelLeftClose, PanelLeftOpen, ArrowUpRight, Command, Users } from "lucide-react";
import { HeroThinkingOrb } from "@/components/MissionOrb.jsx";
import { useRuntime } from "@/components/control/RuntimeProvider.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";

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
  const dialog = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  function openSearch() { setQuery(""); dialog.current?.showModal(); searchRef.current?.focus(); }
  useEffect(() => {
    function onKey(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const matches = destinations.filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
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
      <nav className="controlNav__primary" aria-label="Workspace navigation"><span className="navSectionLabel">WORKSPACE</span>{destinations.slice(0, 6).map(navLink)}</nav>
      <nav className="controlNav__config" aria-label="Agent settings"><span className="navSectionLabel">CONFIGURATION</span>{destinations.slice(6).map(navLink)}</nav>
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
  </>;
}
