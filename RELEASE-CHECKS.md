# Release checks

Panel 0.4.0 is a macOS-first local source release. Hermes is required. A signed native installer and additional agent runtimes are outside this release.

The October 6 review covers per-turn spoken/written instructions, keeping accepted work across Talk/Chat navigation, saved agent profiles, primary SOUL identity, model/workspace selection, native delegated progress, and scoped stop controls. Runtime integration was checked with Hermes `v0.21.5+2142.g085d9ee`. Run the doctor again after updating Hermes: internal contracts can change.

## Reproducible checks

Run `npm test`, `npm run test:e2e`, `npm run test:smoke`, `npm run build`, and `node scripts/release/check.mjs .`. Browser checks need `npx playwright install chromium`; the profile/session/voice-mode tests were additionally exercised with WebKit. CI uses an empty local configuration and deterministic API/provider fixtures. Python ACP/identity/delegation tests in `tests/unit/panel-*.test.py` require a compatible installed Hermes runtime and are separate from the portable Node suite.

`npm run doctor` checks local dependencies and the installed adapter contract without model requests. Source export uses an explicit allowlist and must be scanned before publication. Never distribute `.env` files, runtime data, user agent profiles, recordings, a personal app bundle, or private Git history.

## Live evidence and limits

An isolated real-provider probe on October 6 used DeepSeek Flash for spoken, written, and agent-list turns in the same native conversation. It returned a two-sentence plain spoken answer, a structured written answer, and a native `panel_agents` tool call. A separate saved-agent task was started through the actual Python tool and returned a completed result; status from the wrong parent conversation was rejected. The profile's SOUL, working directory, and selected model matched the native runtime.

Those four test turns took approximately 7.1, 2.6, 3.8, and 4.3 seconds respectively. They are individual observations, not latency guarantees. The first two startup-only attempts in a fresh test Hermes home triggered native first-run packaging; the embedded launcher now disables lazy installs and resolves the installed managed interpreter while retaining dependency activation. Actual model/provider availability still depends on each user's configuration.

Physical microphone/speaker latency and a prolonged hands-free conversation were not verified by these probes. Neither Discord delivery nor a clean installation on a second Mac was tested. These limits prevent a claim that every provider or voice setup works without errors. Transcript persistence, interruption handling, and browser microphone lifecycle tests are separate from audible end-to-end validation.
