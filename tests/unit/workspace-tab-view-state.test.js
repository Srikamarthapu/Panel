import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspaceTabState, workspaceActionPrompt } from "../../lib/workspace-tab-view-state.js";

const spec = {
  blocks: [
    { id: "topic", type: "field", kind: "text" },
    { id: "mode", type: "field", kind: "select", options: ["Quick", "Careful"] },
    { id: "notes", type: "notes" },
    { id: "checks", type: "checklist", items: ["Sources", "Uncertainty"] },
    { id: "facts", type: "table", columns: ["Source", "Claim"] },
    { id: "intro", type: "text", text: "Visible only" },
  ],
};

test("workspace tab state keeps only bounded values declared by the native spec", () => {
  const value = normalizeWorkspaceTabState(spec, {
    fields: { topic: "erosion", mode: "Invalid", secret: "drop" },
    notes: { notes: "local note", secret: "drop" },
    checklists: { checks: [1, 0, true] },
    tables: { facts: [{ Source: "NOAA", Claim: "Observed", Extra: "drop" }] },
  });
  assert.deepEqual(value, {
    fields: { topic: "erosion", mode: "" },
    notes: { notes: "local note" },
    checklists: { checks: [true, false] },
    tables: { facts: [{ Source: "NOAA", Claim: "Observed" }] },
  });
});

test("workspace action prompt substitutes current native state and empties unknown references", () => {
  const state = normalizeWorkspaceTabState(spec, {
    fields: { topic: "erosion", mode: "Careful" },
    notes: { notes: "check dates" },
    checklists: { checks: [true, false] },
    tables: { facts: [{ Source: "NOAA", Claim: "Observed" }] },
  });
  assert.equal(
    workspaceActionPrompt(spec, state, "Review {{topic}} / {{mode}} / {{notes}} / {{checks}} / {{facts}} / {{missing}}"),
    'Review erosion / Careful / check dates / Sources / [{"Source":"NOAA","Claim":"Observed"}] /',
  );
});
