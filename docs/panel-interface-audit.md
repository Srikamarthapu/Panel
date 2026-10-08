# Panel interface audit

This is the final evidence-backed audit of Panel's local-agent workspace as of 2026-10-07. It covers Talk, Chat, Sessions, Tasks, Agents, Models/Jev, Voice, foreground permissions, filesystem-backed profiles, declarative custom tabs, and the native desktop identity.

## Evidence boundary

The assessment uses current source, scoped graph queries, focused unit/runtime/browser suites, official product and design documentation, an isolated live-provider planner run, and an observed native replacement/restart. The isolated planner evidence establishes the tested no-tools path only; it does not establish general provider availability, real Jev routing, physical-device behavior, or a clean install on another Mac.

## Usefulness assessment

Panel has a coherent useful loop: a person can keep durable conversations tied to folders, run foreground work, schedule unattended work, assign model routes, use push-to-talk or hands-free voice, and maintain persistent specialist agents. The strongest implementation evidence is behind the interface: queue claims are idempotent, interrupted unattended work is not replayed, model-test evidence is kept separate from configuration, foreground ACP permission requests are explicit, and profile conversations remain separate.

The largest remaining product gap is outcome review. Completed work surfaces transcripts, status, and a bounded latest result, but no first-class inventory of changed files, patches, or produced artifacts exists across Chat, Tasks, and Agents. That makes the local-agent promise less trustworthy than it should be: users can stop work and read what the agent says, but cannot review a structured account of what changed. Add a read-only run result contract with verified paths, status, diff/stat provenance, and artifact links; never infer changes from model prose.

A second workflow gap is folder selection. Sessions and profiles require a manually typed absolute path. The desktop app should provide **Choose folder…**, return a canonical directory, keep manual entry for browser use, and validate before submit. A working folder is starting context rather than an access boundary; the session editor now states that explicitly.

## Capability findings

| Area | Verified behavior | Limit or correction |
| --- | --- | --- |
| Sessions and history | Server-backed sessions support earlier browser-history adoption, selection, rename, pin, archive/restore, folder validation, full transcript recording, and accepted background runs. | Working folder is not a tool sandbox. The clarified editor copy makes this visible; a native folder chooser remains open. |
| Tasks | Durable entries are idempotent, scheduled, serialized, cancellable, reconciled after restart, and do not replay uncertain external work. | A first visit could display a session while keeping the controlled ID empty, disabling **Add to queue**. Fixed by restoring the active unarchived session after provider boot while preserving manual choice; browser regression added. Unattended tasks use the CLI path and cannot answer foreground ACP prompts, so the copy now directs stopped work to History and its session. |
| Models and Jev | Main, backup, Talk, and Chat assignments remain separate. Catalog degradation preserves saved choices; custom IDs are validated; exact-model probe evidence remains distinct from configuration. Jev only selects eligible configured same-provider choices and fails open to Hermes. | A live provider completed the isolated no-tools planner flow, but real Jev routing was not exercised. The practical reason to change main, backup, or conversation models still assumes substantial user knowledge. |
| Voice | PTT has pointer/keyboard ownership, release-to-send, cancellation on blur/navigation, barge-in, permission states, stop/retry, and a separate hands-free mode. Talk and Chat share one managed session provider. | Physical audio, latency, quota behavior, and native shortcut behavior remain unverified. Dock mode is component-local rather than a saved preference. |
| Permissions and errors | Foreground ACP runs expose bounded requests using advertised options; Chat and Talk render approval UI. Stops and failures remain observable in history, and folder loss has recovery. | Scheduled Tasks intentionally cannot enter this interactive approval flow. The UI must not suggest that queued work waits for live approval. |
| Agents and profiles | Profiles persist `SOUL.md`, optional dedicated workspace, model/provider choice, and a separate session. Manual and delegated runs have status and stop controls. | Workspace separation is not a capability sandbox. Effective roots, model, and permission mode should eventually be inspectable together. |

No additional critical execution failure was established in Sessions/history, Models/Jev, voice, foreground permissions, or profile persistence.

## Declarative custom tabs

The first design accepted arbitrary model-generated HTML in a sandboxed iframe. Browser testing invalidated its claimed no-network boundary: generated JavaScript could navigate its own frame to an external URL despite restrictive resource CSP. Panel replaced that architecture before release rather than claiming that CSP made arbitrary generated code safe.

The current artifact is strict declarative JSON rendered by Panel-owned React components. Its parser allowlists text, fields, notes, checklists, user-entered tables, and reviewed actions; rejects unknown keys, executable fields, generated rows, duplicate IDs, bad action references, bidirectional controls, and oversize specs; markup inside plain text stays inert; and persists validated versioned JSON. The document has no executable script, navigation URL, iframe, provider selector, filesystem primitive, credential access, or permission-answer control.

A tab owns a durable no-tools planning session and a separate execution session. The server derives planner policy from stored session identity, requires ACP, rejects unattended task execution, includes tool policy in runtime identity, binds build to the current plan digest and exact reserved run, and removes tool definitions/toolsets in the Python adapter. A bounded reservation closes the plan-to-run launch race found during review. Review-run metadata also limits a strict fenced-JSON compatibility fallback to the authoritative prepare-plan turn when a provider ignores the requested `panel-plan` fence; ordinary conversation still requires `panel-plan`, and the synthetic format instruction does not enter the returned transcript.

Actions substitute bounded visible field values into a prompt and show the exact result in a Panel-owned review dialog before creating an ordinary foreground run. State writes serialize and coalesce; a local journal survives navigation/reload; save failure offers retry; stop and polling failures preserve the active request. This provides flexible Panel-native instruments without executing a model-authored application. Custom tabs are task-specific Panel forms and checklists, not an arbitrary application builder. They cannot reproduce arbitrary websites or integrations, and connected data must enter through a reviewed Hermes action.

## Primary research and concrete implications

- [Google PAIR: Mental Models](https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/) recommends staged onboarding, benefit-first explanations, and progressive disclosure. Panel should teach **choose a folder → ask for an outcome → review the result** before Jev or provider mechanics.
- [Google PAIR: Patterns](https://pair.withgoogle.com/guidebook-v2/patterns) recommends more control as task risk rises and explanations that support the current decision. For Panel, visible stop controls and structured outcomes matter more than generic model-confidence language.
- [Apple Human Interface Guidelines: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding) recommends brief optional onboarding, sensible defaults, contextual instruction, and permission prompts at first use. Typed Chat should remain immediately usable; microphone access should arise from Talk.
- [Microsoft: Manage security risks for AI agents](https://learn.microsoft.com/en-us/security/zero-trust/sfi/manage-agentic-risk) emphasizes boundaries for what agents access, do, and remember, plus immediate pause/stop and activity visibility. Panel has stops and activity but still needs clearer folder-policy and changed-file review.
- [Microsoft: Design foundations for agents](https://learn.microsoft.com/en-us/agents/design-guidelines/design-foundations) supports explicit user control, transparent agent state, and interaction patterns suited to delegated work. Panel should keep planning, review, execution, and permissions visibly distinct.
- [OpenAI: Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/) makes project-grouped threads, continuity, reviewable diffs, and isolated worktrees central to parallel-agent supervision. Panel has persistent threads and specialists but does not yet offer isolation or diff review, so workspace language must stay qualified.
- [OpenAI: Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) describes a bidirectional event stream for progress and server-initiated approvals. Panel's ACP events align with this model; list and result surfaces should consume more structured run evidence.
- [Anthropic: Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) exposes resumable sessions, extra working roots, plan mode, and explicit allowed/disallowed tools. A mature Panel profile should show session, roots, model, and effective permission mode together.

## Native identity

The Tauri source now uses **Panel** for the product, window, tray, menu, microphone permission, and bundle description while keeping `ai.hermes.control`, the Rust package, executable, and user data/config identity stable. The regenerated icon is a charcoal rounded macOS tile with Panel's sage particle-orb mark; it contains no lettermark or legacy octopus.

The installed legacy application was first observed still showing the old octopus identity. Integration then replaced `/Applications/Hermes Control.app` with the freshly built `/Applications/Panel.app` while retaining a backup, verified its ad hoc signature, restarted the private LaunchAgent with the fresh 16.3.8 build, matched the API build identity, and opened the Panel native shell onto the localhost workspace through computer-use observation. Six configuration fingerprints and 99 history fingerprints were unchanged across the replacement. This verifies the tested Mac's replacement and data continuity; it is not notarized-distribution evidence or a clean-install result. The public source export excludes the native wrapper.

## Validation

- Private integration suite: `npm test` passed 395 unit tests plus 118 property tests; the final Chromium suite passed 79/79 on 16.3.6.
- Public Next.js 16.3.8 validation: 392 unit tests and 118 property tests passed; Chromium passed 79 with one expected native-wrapper-only skip; the 11 selected new-flow WebKit checks passed. The synthetic audio fixture now waits for actual encoded bytes before release, retaining the production recorder and minimum duration, and separately verifies that a short press does not send. Its parallel stress check passed 35/35.
- Custom-tab unit contract: 9/9 passed.
- Custom-tab planner and native host browser coverage: 3/3 passed.
- Focused Tasks first-visit regression: passed; earlier focused queue/browser run passed 2/2.
- Sessions, Tasks, Models, voice route mode, and Agents deterministic browser set: 26/26 passed.
- First-run replay, provider-error, and accessibility coverage: 2/2 passed.
- Declarative backend hardening: 16/16 passed, including no-tools identity, exact plan/run binding, launch reservation, UTF-8 limits, and bidi rejection.
- Targeted model/session/queue/voice JavaScript suites: 65 passed; Python profile identity: 7/7.
- Jev runtime suites: 27 + 16 + 7 passed.
- Native branding sources passed JSON/plist/Rust metadata checks; the native `Panel.app` and DMG build completed in the root integration run.
- A real isolated provider run completed two natural requirement turns, **Prepare plan**, and the approved build in approximately 10.5, 8.5, 4.1, and 3.5 seconds. It produced four valid native blocks with zero tool calls and zero tool events. These are individual observations, not latency guarantees. A real reviewed custom-tab action was not sent to a provider.
- The 16.3.6 Next.js audit reported one high advisory and five additional advisories. Updating to 16.3.8 resolved the audit to zero. [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) applies to `remotePatterns`; Panel does not configure that feature, so this audit does not claim the advisory was exploitable in Panel.

Real Jev routing, a physical voice turn, a live custom-tab Hermes action, a clean install on a second Mac, public notarization, and a real-user workflow study remain unverified. The public source release contains the web application and excludes the native wrapper.
