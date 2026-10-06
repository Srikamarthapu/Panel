"use client";
import Link from "next/link";
import { ChevronRight, Cpu, Radio } from "lucide-react";
import { useRuntime } from "./RuntimeProvider.jsx";

const labels = { overview: "Talk", chat: "Chat", tasks: "Tasks", sessions: "Sessions", memory: "Memory", models: "Models", voice: "Voice settings", tools: "Tools", settings: "Settings" };
export default function WorkspaceHeader({ active }) {
  const runtime = useRuntime();
  const model = runtime?.snapshot?.model;
  return <header className="workspaceHeader">
    <div className="workspaceBreadcrumb"><span>Personal workspace</span><ChevronRight size={13} /><strong>{labels[active] || active}</strong></div>
    <div className="workspaceHeader__right">
      <Link href="/models" className="modelPill"><Cpu size={14} /><span>{model?.model || "Model settings"}</span></Link>
      <span className="localPill"><Radio size={13} />Local</span>
    </div>
  </header>;
}
