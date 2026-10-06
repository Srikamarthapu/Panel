import TalkWorkspace from "@/components/control/TalkWorkspace.jsx";
import AgentWorkspace from "@/components/control/AgentWorkspace.jsx";

export default function Stage({ active, children }) {
  return (
    <main id="workspace-content" className={`stage${["overview", "chat"].includes(active) ? " stage--overview" : ""}`} tabIndex={-1}>
      {active === "overview" ? <TalkWorkspace /> : active === "chat" ? <AgentWorkspace /> : <div className="stage__body">{children}</div>}
    </main>
  );
}
