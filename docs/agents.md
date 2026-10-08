# Conversations and agents

Talk and Chat share the selected conversation. Every new request carries its own response mode. Spoken turns ask Hermes for natural, concise speech; typed turns allow the detail, Markdown, and code the task needs. Opening Chat stops microphone capture, cues, and speech playback while accepted work continues. Returning to Talk does not reopen the microphone until you activate it. An in-flight model turn retains the instructions it started with; its result remains available in the transcript.

## Saved agents

Open **Agents → New agent**. Give the agent a name and describe its role in **SOUL.md**. Choose an existing working folder or leave it empty for a separate folder. Supply both provider and model ID to pin a connected model, or leave both empty to follow the configured Talk & Chat model. Provider suggestions come from the local Hermes catalog; a saved model ID does not prove inference access.

Each profile has its own on-disk SOUL.md, working directory, selected model, and persistent conversation. Files live under `PANEL_DATA_DIR/agents/<id>/` (or Panel's `data/agents/<id>/` default). The runtime uses that SOUL as the primary identity, including restored sessions. Blank profiles receive a minimal identity using their chosen name.

Profiles use the installed Hermes credentials, tools, skills, and global memory. They are not separate OS accounts or security sandboxes. A folder selects the starting workspace; it does not restrict a tool's filesystem permissions.

Use **Run task** to start work without leaving your current conversation. Open **Conversation** to talk directly to that agent, inspect the full result, or handle a permission request. Edit an idle profile to change its role or model. **Archive** hides it and its conversation without deleting files; **Archived → Restore** brings it back. Active or delegated work must finish or stop before editing a profile.

## History and usage

Archiving a conversation does not archive its agent profile. Opening that agent or sending its next task starts a fresh conversation when needed; earlier messages stay archived. Profile archive remains a separate action on the Agents page.

The Agents page shows cards with runtime, token usage, and estimated cost across the profile’s conversations, including archived ones. Missing metrics stay unavailable and incomplete history is marked partial. Cost uses Hermes’s reported turn usage and pricing estimates; auxiliary calls and provider retries are excluded, so these figures are not a provider bill.

Select **Add to Talk** to show a companion beside the main agent. **Settings → Companion glow / Companion float** controls the effects independently. Motion follows the effective System, Full, or Reduced setting.

## Delegation

When the Panel ACP adapter is available, Hermes receives a `panel_agents` tool. It can list saved profiles and start independent tasks with an appropriate teammate. Status and stop actions are scoped to the conversation that launched the task. The local UI can manage any of your own agents. Explicitly configured profile models take precedence over automatic model routing.

Hermes's native `delegate_task` children appear under **Delegated subtasks** with actual lifecycle events, results, and supported stop controls. These are temporary workers, distinct from saved profiles. Events are retained after the parent answers, so background work stays visible. A stop acknowledgment displays **Stopping** until the native lifecycle confirms completion; completed side effects are not undone.

The agent pane is available in Talk and Chat and opens when new agent work begins. Up to four Panel conversations can run concurrently. Native temporary workers follow Hermes's own limits. The app must remain running for local work to continue.

## Compatibility

`npm start` and `npm run dev` enable the persistent ACP runtime by default. If launching Next directly, set `HERMES_VOICE_TRANSPORT=acp`. The Control adapter checks the installed Hermes ACP contract and reports incompatibility rather than silently replacing a conversation. Profile identity and delegated progress additionally rely on the native prompt and delegation hooks verified by the Python adapter tests. No Hermes installation files or original SOUL.md are rewritten by this feature.
