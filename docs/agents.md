# Conversations and agents

Talk and Chat share the selected conversation. Every new request carries its own response mode. Spoken turns ask Hermes for natural, concise speech; typed turns allow the detail, Markdown, and code the task needs. Opening Chat stops microphone capture, cues, and speech playback while accepted work continues. Returning to Talk does not reopen the microphone until you activate it. An in-flight model turn retains the instructions it started with; its result remains available in the transcript.

## Saved teammates

Open **Agents → New teammate**. Start with a name and a clear role, or choose a Researcher, Builder, or Reviewer template and adapt it. The role is required and is stored in `SOUL.md`. Advanced setup contains color, folder, provider, and model choices; its summary shows the current model and folder mode. Leave the folder empty for a separate managed folder. Supply both provider and model ID to pin a connected model, or leave both empty to follow the configured Talk & Chat model. Provider suggestions come from the local Hermes catalog; a saved model ID does not prove inference access.

New teammates start with an explicit allowlist containing no tools and no skills. In **Tools and skills**, search or browse the installed catalog and select only the capabilities that role needs; an empty selection means none. Older profiles created before capability policies show **Legacy inherited access** until you choose an allowlist. If a selected capability is later removed from Hermes, the profile stays editable but cannot launch until you repair its selection.

The workspace header labels a teammate's pinned model when one is saved. An unpinned teammate is labeled as following Talk & Chat because that assignment can differ from the main model. These labels describe the next request's saved route. A completed run identifies the actual runtime route only when the connected runtime reports it; otherwise its receipt keeps the requested route labeled as requested.

Each profile has its own on-disk SOUL.md, working directory, selected model, and persistent conversation. Files live under `PANEL_DATA_DIR/agents/<id>/` (or Panel's `data/agents/<id>/` default). The runtime uses that SOUL as the primary identity, including restored sessions.

In Hermes mode, the persistent ACP runtime filters the tool schemas shown to a restricted teammate and checks the same allowlist again when a tool or skill is loaded or executed. Restricted teammates cannot delegate to saved or temporary agents and cannot create scheduled work because those paths do not yet inherit the parent policy. A restricted Hermes profile is therefore blocked on legacy CLI and scheduled transports rather than launched with broader access.

Capability policies are not OS sandboxes. A folder selects the starting workspace; it does not restrict an allowed tool's filesystem permissions. Skill selection controls Hermes skill discovery and loading, but an independently allowed file or terminal tool can still read files that its normal host permissions allow. Direct API conversations have no tools or skill loader, so the profile's role and conversation context apply there while its saved capability choices wait for Hermes mode.

Use **Run task** to start work without leaving your current conversation. Open **Conversation** to talk directly to that agent, inspect the full result, or handle a permission request. Edit an idle profile to change its role or model. **Archive** hides it and its conversation without deleting files; **Archived → Restore** brings it back. Active or delegated work must finish or stop before editing a profile.

## History and usage

Archiving a conversation does not archive its agent profile. Opening that agent or sending its next task starts a fresh conversation when needed; earlier messages stay archived. Profile archive remains a separate action on the Agents page.

The Agents page shows cards with runtime, token usage, and estimated cost across the profile’s conversations, including archived ones. Missing metrics stay unavailable and incomplete history is marked partial. Cost uses Hermes’s reported turn usage and pricing estimates; auxiliary calls and provider retries are excluded, so these figures are not a provider bill.

Terminal runs can show **Review work** in the transcript, Agents, and Tasks. The receipt keeps the agent's final summary separate from runtime status, structured tool receipts, and file locations reported by those tools. Completed edit, move, or delete receipts and bounded post-run checks appear as execution evidence, but they do not prove the current contents of a file. When no structured evidence was reported, the receipt says so instead of inferring changes from the answer text. Older saved results and temporary-worker summaries can have less detail.

A newly saved teammate appears automatically in Agents and Talk; creating the profile does not start a task. Use the **In Talk** / **Add to Talk** control on each agent card to manage companion visibility. **Settings → Companion glow / Companion float** controls the effects independently. Motion follows the effective System, Full, or Reduced setting.

**Memory** lists the main assistant and every saved teammate with current activity, profile role, and associated conversation history. Hermes long-term memory and the user profile are one shared installation-level source, not a separate database owned by each teammate. That shared Hermes memory is available to Hermes-mode conversations and is not sent to Direct API conversations.

## Delegation

When the Panel ACP adapter is available, the main Hermes assistant receives a `panel_agents` tool. It can list saved profiles, create a requested profile with a bounded explicit tool and skill allowlist, and start beneficial independent tasks with an appropriate teammate. Creation uses a stable idempotency key, defaults omitted capability lists to none, and does not start the new profile. The new teammate appears in Agents and Talk through the same saved-profile data used by the UI.

Delegated tasks should carry the context needed to work independently, a non-overlapping scope, the expected output, and relevant verification. Acceptance only confirms that work was queued; Hermes must collect a terminal result before treating it as complete. A status call waits briefly for a terminal state and otherwise reports an honest timeout with a fresh observation timestamp; call status again when it remains active. Saved-agent results are not automatically delivered back into the calling conversation. Status and stop actions are scoped to the conversation that launched the task. Restricted saved teammates do not receive `panel_agents` or native delegation tools, so they cannot widen their own policy by creating or launching another agent. The local UI can manage any of your own agents. Explicitly configured profile models take precedence over automatic model routing.

Hermes's native `delegate_task` children appear under **Temporary workers** with recorded queued, running, stopping, failed, stopped, and completed lifecycle events, bounded progress, result summaries, and supported stop controls. These are temporary workers, distinct from saved profiles. Scheduled and recurring work stays in **Tasks**. Events are retained after the parent answers, so background work stays visible. A stop acknowledgment displays **Stopping** until the native lifecycle confirms a terminal state; completed side effects are not undone. Temporary-worker result summaries do not claim the full tool and file evidence available on a Panel-managed conversation run.

The agent pane is available in Talk and Chat and opens when new agent work begins. Up to four Panel conversations can run concurrently. Native temporary workers follow Hermes's own limits. The app must remain running for local work to continue.

## Compatibility

`npm start` and `npm run dev` enable the persistent ACP runtime by default. If launching Next directly, set `HERMES_VOICE_TRANSPORT=acp`. The Control adapter checks the installed Hermes ACP contract and reports incompatibility rather than silently replacing a conversation. It also classifies `web_extract` receipts from their structured result envelope, so successful entries whose `error` field is null remain successful while top-level, per-page, mixed, and malformed failures remain failed. Profile identity and delegated progress additionally rely on the native prompt and delegation hooks verified by the Python adapter tests. No Hermes installation files or original SOUL.md are rewritten by this feature.
