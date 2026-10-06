# Panel harness rework

Scope: the independent public source copy. Personal installations can use the same application code while keeping their own configuration, local data, and repository history.

## Findings and acceptance checks

1. Legacy dashboard pages obscure the actual agent workflow. Replace their navigation with sessions, a real task queue, and a read-only skills/plugin inventory. Preserve Talk, Chat, model selection and voice settings.
2. Browser-only conversation history cannot support returning to independent work. Persist named sessions, their transcripts, working directories and exact Hermes continuation IDs on the local server. Verify reload and session isolation.
3. A task board is not unattended execution. Persist queued work and schedules; supervise a single worker while Panel runs; reconcile interrupted runs without replaying potentially completed actions. Verify scheduling, cancellation and restart recovery.
4. A model-catalog exception erases saved selections and incorrectly blames the gateway. Read saved settings independently of provider discovery and show accurate compatibility errors. Verify catalog failures and cold loads.
5. First voice use has multiple cold stages. Overlap safe preparation, retain sparse acknowledgements after acceptance, measure individual stages, and keep terminal errors visible. Physical microphone and speaker latency requires device testing.
6. Bloub should attend to the pointer while idle, with reduced-motion, visibility and lifecycle guards.
7. Export only reviewed source. Exclude personal state, keys, histories, caches and the original Git history. Validate the source manifest and a clean install before distribution.
8. Independent review reproduced cancellation after an early answer marking a task stopped while its process continued. Preserve the answer while cancelling remaining execution; verify against a live harmless child process.
9. Independent review reproduced an abruptly killed helper leaving its detached Hermes process running, then allowing another turn in the same session. Track/reconcile the full execution group before freeing the session. Verify orphan prevention and safe restart.
10. Setup must preserve existing environment files and use the same configuration precedence and Python installation as the running app. Verify custom paths without modifying Hermes.

## Runtime contracts

- `GET/POST /api/sessions`, `GET/PATCH /api/sessions/:id`: named local sessions and server-owned message history.
- `GET/POST/PATCH /api/tasks`: durable work queue, scheduling and cancellation, plus worker health.
- Talk and Chat share the selected session. Switching is disabled during live voice interaction and until a new request is acknowledged by the server. Accepted work can continue in the background; results remain attached to their own session.
- Tasks can continue with the browser closed. Panel and the computer must remain running. Stopping an action does not undo completed work.
- Hermes remains the first supported agent runtime. Provider/model choice remains configurable; a model API alone does not supply the tool and permission runtime.

## Initial 0.2.0 verification

Verified on macOS with Node 22.22.3 and Hermes v0.21.5+2142.g085d9ee:

- 257 unit tests, 118 property tests, and 50 Jev runtime tests passed.
- All 24 browser checks passed against the production build: session creation/rename/resume/reload, session isolation, interrupted runs, queued tasks, metadata inventory, legacy redirects, keyboard access, contrast, and narrow layouts. Separate voice fixtures covered repeated turns, permission races and cancellation.
- Three independent process regressions passed: stop after an early answer, orphan cleanup after helper death (including a child that ignores the first stop signal), and protection against reusing old process IDs.
- The live production queue accepted and deduplicated a task, delivered its answer, resumed the same saved session, and retained four messages. Both executions finished with no remaining tracked process. A neutral arithmetic follow-up returned the expected answer. The first exact-string probe was refused by the model's instructions; transport and persistence worked, but that response was not counted as an exact-answer pass.
- Real queued answers took approximately 20–28 seconds across the checks. Jev decisions were observed in the Hermes loop. A separate real model-routing check selected the configured fast model in 226 ms (496 ms including the bridge). These are individual measurements, not latency guarantees.
- Model discovery loaded seven providers and preserved the saved selections. The failure was an incompatible optional `ProviderDescriptor.keyless` field; local catalog reads now avoid credential refresh side effects. Missing/partial profiles retain saved choices with accurate warnings.
- Production build, local doctor, and a fresh source-only `npm ci` plus build passed. The clean build used an empty Hermes home/repository and missing CLI, confirming that compilation does not depend on personal credentials. It emitted three nonfatal Turbopack warnings for dynamic local data paths; standalone/native binary distribution remains outside this release.
- The source export contained 259 reviewed entries. Pattern scanning found no issues; comparison against 24 locally saved credential values found no matches. Local data, original Git history, build output, recordings and screenshots are excluded. Dependency audit reported zero production vulnerabilities.
- The original desktop server and private configuration were left unchanged. No Discord messages were sent.

This is a source release candidate. Physical microphone/speaker latency, a longer natural-conversation soak, a second clean Mac, and a signed/notarized installer remain unverified. Voice preparation and acknowledgement timing are improved, but consistently instant conversation is not established. Scheduled tasks require the app and computer to remain running.

## 0.2.1 upgrade corrections

- Corrected the pointer pitch sign using the engine's projected SVG eye coordinates. Pointer tracking now paints every animation frame, uses a 45 ms smoothing time constant, and suppresses ambient gaze drift while following the cursor. Direction and convergence are tested at 60 and 120 Hz; reduced-motion and visibility guards remain in place.
- Added one-time adoption of legacy browser conversations under their exact existing Hermes session IDs. The original browser copy remains untouched. Existing server receipts win, duplicate imports do not add messages, and a valid selected session stays selected. Stale selections also recover legacy history.
- Added one inherited version stamp for the entire build. Next evaluates configuration in several processes; separate timestamps had produced inconsistent manifest/API/client versions and could trigger unnecessary refreshes.
- The personal desktop update transfers application source only. Its private configuration and data are not copied into the public project, and the prior build is retained for rollback.

Verified for 0.2.1 on the same Mac:

- 261 unit tests and 118 property tests passed. All 28 browser checks passed against the personal production build, followed by 11 focused browser checks after the final stale-selection correction. Pointer tests cover all four directions and reduced motion; adoption tests cover reload, existing selections and stale selections.
- The previous inverted pitch was reproduced against rendered SVG eyes before the fix. The corrected engine projection and time-based smoothing passed at 60 and 120 Hz.
- Direct HTTP checks confirmed exact-session adoption, idempotent retries and invalid-input rejection. The native desktop opened the new layout with its previous conversation recovered.
- The active desktop build matches its status API version. Five private configuration fingerprints remained unchanged, with the previous build and source backup retained for rollback.
- A fresh 0.2.1 source-only install and production build passed with an empty Hermes home/repository and unavailable CLI. The export contains 263 reviewed source entries; pattern scanning found no issues, and comparison against 24 saved credential values found no matches.

## 0.3.0 interaction and lifecycle review

- The native listener cleanup could call an already removed Tauri listener and leave an unhandled rejection. Cleanup now observes both synchronous and asynchronous failures, disposes once, and ignores callbacks after unmount.
- Quick push-to-talk releases could race React state or microphone permission/startup. A synchronous gesture owner now separates release-to-send from cancellation, and stale startup completions cannot start a recording. Pointer, Space and Enter share the same contract; blur, lost capture, hidden pages and unmount cancel.
- A locally generated request ID did not prove that the server accepted work. Session switching now waits for the matching accepted action ID or an authoritative restored run.
- Session edits and run/queue admission share a disk lock. Active or scheduled work prevents archive/folder changes. Rename and pin remain available; archiving is reversible. Four active requests are allowed globally, including completed receipts whose process is still finishing. Queue capacity collisions leave work queued.
- The optional Agents pane shows real run summaries and individual cancellation. It creates independent conversations; it does not claim filesystem isolation or automatic orchestration.
- Compact chat headers, message actions, composer and session controls replace the oversized layout. Native dialogs support keyboard focus and Escape. Per-session drafts persist, and unrelated global events cannot populate a conversation's activity.

Physical microphone/speaker and longer natural-conversation testing remain separate from synthetic browser coverage. Provider response time is not guaranteed by these changes.

Current live text check: the production browser server accepted a harmless arithmetic request in 52 ms, returned the correct answer in 15.5 seconds, recorded Jev activity, and persisted both messages. The model catalog loaded seven provider groups. This is one measured request, not a latency guarantee or a microphone/playback test.
