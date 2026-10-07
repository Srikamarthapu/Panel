# Hermes Control reliability rebuild — September 19, 2026

## Problems addressed

| Reported problem | Finding | Change |
| --- | --- | --- |
| Chat cuts off at 500 characters | Composer, reducer, and transcript normalization each had their own short cap; the direct model path also allowed only 220 output tokens. | 32,000-character messages and 64,000-character stored replies. Oversized input is rejected visibly. Speech uses a separate excerpt, with the full answer retained in Chat. |
| Tool markup appears as an answer | A keyword classifier sent many requests to a tool-less model. Detached actions scraped ordinary CLI stdout; DSML was not filtered. | All turns use the real Hermes runtime and its structured event protocol. Only a terminal result becomes a reply. DSML is filtered, and unexecuted tool instructions produce a visible error rather than a success claim. |
| Follow-ups lose context | Every detached action started a new CLI session. | Persist the exact Hermes session ID and resume it for subsequent Talk/Chat turns. Import limited earlier browser history only when creating the first runtime session. |
| Voice hangs or behaves inconsistently | Unrelated state/config polling cancelled effect sequences; old network responses could arrive after cancellation; muted completions were discarded. | Effects survive unrelated renders; requests carry cancellation signals and operation IDs; muted/text results remain in the transcript. Stop cancels the local run, including before its POST finishes. |
| STT errors appear as user messages | Raw error envelopes had entered transcript storage. Historical logs recorded only `fetch failed`, without a cause. | Typed errors with retryability and diagnostics; known historical envelopes are reattributed. Bounded transient retries, no TLS bypass, no raw transcript logs or retained temporary recordings. The historical network cause remains unknown. |
| Lost or duplicate completion | An activity feed was the only answer delivery channel, with short caps, concurrent writers and page-load timestamp filtering. | Durable per-run result files, per-conversation single-flight guard, idempotent request IDs, polling/reload recovery, serialized writes and separate tool-progress events. |
| Choppy or stale speech | Network failures rotated through every TTS key without a timeout; stop did not reach the upstream request. | Bounded first-byte wait, upstream cancellation, one service failure instead of repeated key attempts, cancellable Edge fallback. Voice activity is visual instead of repeated spoken waiting messages. |
| Cramped/overlapping chat | Header, history and composer did not have a stable viewport layout; replies were unformatted text. | A single history scroll region, stable composer, preserved drafts, safe Markdown, copy and latest-message controls, and explicit error/stop/retry feedback. Talk keeps the imported orb in a fixed slot. |
| Model list suggests unavailable choices | NVIDIA used a fixed allowlist; fallback display expected the wrong data shape; voice-only protocol restrictions disagreed with the actual runtime. | Discover through installed Hermes, filter documented hosted deprecations and specialized services, label access unverified, preserve warnings for saved IDs, and use the same provider setup for Talk/Chat. |

## Runtime contract

`POST /api/voice/chat` queues a request and returns a request ID, not a spoken acknowledgement or purported answer. The helper uses `hermes chat --format stream-json --query-file …` and resumes the mapped Hermes session. It does not force `--yolo`; installed Hermes permissions still apply. Tool arguments/results and private reasoning are excluded from the UI feed. Tool activity is visible under Thinking.

`GET /api/voice/runs` reads a durable result, including after a reload. `DELETE /api/voice/runs` stops the request. Stopping does not undo already-completed external actions. Errors and uncertain outcomes are not automatically replayed, avoiding duplicate side effects. Runs have a 12-minute execution limit and a 15-minute stale-run recovery limit.

Run records and session mappings are local, ignored by Git, and created with owner-only permissions under `data/assistant-runs/`. Transcripts and drafts are also saved in the browser. API configuration responses exclude provider keys and webhook URLs.

## Jev

Jev now runs inside the Hermes loop, selecting actual available tools at each eligible step. Supported read-only actions with complete known arguments skip a frontier call; open-ended arguments still come from Hermes. The extension also provides progress feedback and request-only selection of older tool context. A harmless full dashboard-runner check (run `jev-dashboard-1789872487`, dashboard session `jev-dashboard-session-1789872487`) recorded a Jev selection, an actual read-only `terminal` tool call and result, a Jev finish evaluation, and a terminal Hermes answer. The durable run recorded `jev.observed: true` with two evaluations; no personal-service action ran. This proves integration, not an end-to-end speedup. See [Jev integration](jev.md) and [model catalog](model-catalog.md).

## Validation boundary

Offline checks cover reducer lifecycle, request cancellation, long text, DSML split across tokens, final-result extraction, durable session resumption, and a fixture CLI that emits real protocol shapes without contacting providers or performing actions. The fixture confirms no raw tool input/output becomes the answer and no `--yolo` flag is injected. Obsolete source-regex assertions for the removed fast/data-lane split were replaced by behavioral lifecycle coverage.

The voice follow-up exercised the actual browser VoiceProvider with synthetic microphone input, real VAD/MediaRecorder/playback, mocked request boundaries, two consecutive turns, PTT cancellation, and deferred-permission cancellation/restart. A second check covered direct microphone reacquisition without gesture priming. Both browser scenarios passed. Separate configured-provider checks sent a synthetic WAV to Deepgram and received a valid decodable MP3 from ElevenLabs. No ambient microphone recording, native WKWebView playback, or personal-service action was exercised. The Jev integration check used the actual dashboard runner, Hermes inference path, and a harmless read-only local tool. Catalog discovery is not an inference-access test. CLI startup overhead and provider latency still apply; this is not a persistent warm worker or a claimed low-latency benchmark.

## Installed build

- Current production build: `hermes-control-20260919-voice-avatar`, build completed successfully.
- The earlier harness unit suite passed 186 cases. This voice/avatar follow-up passed 56 selected lifecycle/property cases, 13 avatar/presence cases, and a final focused 19-case lifecycle run; counts overlap and are not additive. A temporary ESLint undefined-variable check on VoiceProvider passed with zero errors.
- Knowledge graph updated after the code changes.
- Local launch service restarted. Its status endpoint returned HTTP 200 with the exact build ID above and configuration readiness `configured` (not a live provider check).
- Unnecessary tracing of runtime memory/configuration files into the production package was removed.
- Jev follow-up: 17 loop fixtures and 15 context fixtures passed against the installed Hermes adapters. Seven focused dashboard settings/run/status cases also passed. Both request and execution middleware registered through the installed Hermes loader; live settings report Jev enabled and all four controls on.
- The installed Talk page renders the upstream Bloub engine and a persistent Orb/Bloub switch. Its avatar and caption share acknowledged voice/run presence. The production development-fixture route returns 404.
