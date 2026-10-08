# Custom workspace tabs

Use **+ beside Workspace** to discuss a new tab with Hermes. Start with the outcome, the information you need, and the actions it should support. Hermes asks follow-up questions. After at least two completed exchanges, use **Prepare plan** if no plan has appeared yet.

Review the proposed features, connections, boundaries, and checks. **Build this preview** produces a local preview; **Add to workspace** adds the reviewed version to navigation. Closing the planner keeps its conversation. Drafts remain in the sidebar, and the plus dialog also lists archived tabs. Archiving keeps files and can be reversed. Rebuilding keeps the earlier published version available until you choose to replace it.

## What a tab can do

Tabs use Panel's native text, input, notes, checklist, editable table, and action blocks. They inherit the app's theme and accessibility controls. Values save locally; a browser draft journal helps recover edits if a save is interrupted. Save errors remain visible with Retry save.

A tab can assemble a concrete Hermes task from its fields. It shows the **exact request for review** before running it through the configured Hermes agent. Execution has its own saved conversation, real progress, stop controls, and permission handling. Open the execution chat to inspect results or respond to a tool permission request. Closing a view does not undo accepted work.

For example, a market research tab can hold a watchlist and ask Hermes to retrieve a bounded report from a configured data tool. A tab does not install a market integration, connect a brokerage, or start trading simply because its plan mentions them. Connections must exist in Hermes and any real action remains subject to the normal task and tool permissions. Prices and results are not fabricated.

## Boundaries

- Planning and preview generation run with execution tools disabled in the native runtime. This requires Panel's default ACP transport.
- Generated tabs contain a strictly validated JSON layout, never arbitrary HTML, JavaScript, plugins, or network code. They are useful structured workspaces, not a general-purpose application builder.
- Creating a tab is separate from scheduling unattended work. Use Tasks for the latter; Panel and the Mac must stay running.
- Tab state is limited to 100 KB. An individual layout has up to 20 blocks. Tables support up to 100 locally entered rows.
- Local storage is not a secrets vault. Put credentials in the appropriate provider or Hermes configuration, not in tab fields or planning chat.

## Files on your Mac

Each tab's planner shows its exact folder. By default it is `data/workspace-tabs/<id>/` under Panel (or under `PANEL_DATA_DIR`). The folder contains its configuration, local state, and versioned layout files. Planning and execution transcripts are saved in Panel's normal session storage. Agent folders and working directories do not restrict what authorized Hermes tools can access.
