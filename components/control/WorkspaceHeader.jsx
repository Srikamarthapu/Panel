"use client";
import { ChevronRight, Radio } from "lucide-react";
import { useRuntime } from "./RuntimeProvider.jsx";

const labels = { overview: "Talk", chat: "Chat", tasks: "Tasks", sessions: "Sessions", agents: "Agents", memory: "Memory", models: "Models", voice: "Voice settings", tools: "Tools", settings: "Settings", workspace: "Workspace tab" };
export default function WorkspaceHeader({ active }) {
  const runtime = useRuntime();
  const executionMode = runtime?.snapshot?.runtime?.mode || "hermes";
  return <header className="workspaceHeader">
    <div className="workspaceBreadcrumb"><span>Personal workspace</span><ChevronRight size={13} /><strong>{labels[active] || active}</strong></div>
    <div className="workspaceHeader__right">
      <span className="localPill"><Radio size={13} />{executionMode === "direct" ? "Direct API" : "Local"}</span>
    </div>
  </header>;
}
