"use client";
import Link from "next/link";
import { ChevronRight, Cpu, Radio } from "lucide-react";
import { useRuntime } from "./RuntimeProvider.jsx";
import { useWorkSessions } from "@/components/work/WorkSessionProvider.jsx";

const labels = { overview: "Talk", chat: "Chat", tasks: "Tasks", sessions: "Sessions", agents: "Agents", memory: "Memory", models: "Models", voice: "Voice settings", tools: "Tools", settings: "Settings" };
export default function WorkspaceHeader({ active }) {
  const runtime = useRuntime();
  const work = useWorkSessions();
  const model = runtime?.snapshot?.model;
  const modelName = work?.activeAgent?.model || (model?.model !== "unknown" && model?.model) || "Choose a model";
  return <header className="workspaceHeader">
    <div className="workspaceBreadcrumb"><span>Personal workspace</span><ChevronRight size={13} /><strong>{labels[active] || active}</strong></div>
    <div className="workspaceHeader__right">
      <Link href={work?.activeAgent ? "/agents" : "/models"} className="modelPill"><Cpu size={14} /><span>{modelName}</span></Link>
      <span className="localPill"><Radio size={13} />Local</span>
    </div>
  </header>;
}
