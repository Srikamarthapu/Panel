import TabRail from "./TabRail.jsx";
import Stage from "./Stage.jsx";
import WorkspaceHeader from "@/components/control/WorkspaceHeader.jsx";

export default function Shell({ active, children }) {
  return (
    <div className="shell controlShell" data-route={active}>
      <a className="skipLink" href="#workspace-content">Skip to content</a>
      <TabRail active={active} />
      <div className="workspaceFrame">
        <WorkspaceHeader active={active} />
        <Stage active={active}>{children}</Stage>
      </div>
    </div>
  );
}
