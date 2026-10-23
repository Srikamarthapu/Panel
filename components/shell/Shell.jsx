"use client";

import { usePathname } from "next/navigation";
import TabRail from "./TabRail.jsx";
import Stage from "./Stage.jsx";
import WorkspaceHeader from "@/components/control/WorkspaceHeader.jsx";
import ModelResolutionProvider from "@/components/control/ModelResolutionProvider.jsx";
import { workspaceRouteKey } from "@/lib/workspace-route.js";

export default function Shell({ children }) {
  const active = workspaceRouteKey(usePathname());
  return (
    <div className="shell controlShell" data-route={active}>
      <a className="skipLink" href="#workspace-content">Skip to content</a>
      <TabRail active={active} />
      <div className="workspaceFrame">
        <ModelResolutionProvider>
          <WorkspaceHeader active={active} />
          <Stage active={active}>{children}</Stage>
        </ModelResolutionProvider>
      </div>
    </div>
  );
}
