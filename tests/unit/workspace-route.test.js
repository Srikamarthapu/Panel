import test from "node:test";
import assert from "node:assert/strict";
import { workspaceRouteKey } from "../../lib/workspace-route.js";

test("workspace route keys cover fixed and custom workspace destinations", () => {
  assert.equal(workspaceRouteKey("/"), "overview");
  assert.equal(workspaceRouteKey("/chat"), "chat");
  assert.equal(workspaceRouteKey("/settings/"), "settings");
  assert.equal(workspaceRouteKey("/workspace/research-desk"), "workspace");
});
