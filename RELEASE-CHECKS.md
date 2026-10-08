# Release checks

Panel 0.5.0 is a macOS-first local source release. Hermes is required. The public source export excludes the native wrapper; a notarized native installer and additional agent runtimes are outside this release.

The October 6 review covers per-turn spoken/written instructions, keeping accepted work across Talk/Chat navigation, saved agent profiles, primary SOUL identity, model/workspace selection, native delegated progress, and scoped stop controls. Runtime integration was checked with Hermes `v0.21.5+2142.g085d9ee`. Run the doctor again after updating Hermes: internal contracts can change.

The October 7 review adds optional first-run setup, agent appearance and storage visibility, persistent teammate selection, a reviewed custom-tab workflow, and a queue-form session fix. Custom layouts are validated data rendered by Panel; arbitrary model-generated HTML/scripts are not executed. See [the interface audit](docs/panel-interface-audit.md) and [custom tabs](docs/workspace-tabs.md).

## Reproducible checks

Run `npm test`, `npm run test:e2e`, `npm run test:smoke`, `npm run build`, and `node scripts/release/check.mjs .`. Browser checks need `npx playwright install chromium`; the profile/session/voice-mode tests were additionally exercised with WebKit. CI uses an empty local configuration and deterministic API/provider fixtures. Python ACP/identity/delegation tests in `tests/unit/panel-*.test.py` require a compatible installed Hermes runtime and are separate from the portable Node suite.

`npm run doctor` checks local dependencies and the installed adapter contract without model requests. Source export uses an explicit allowlist and must be scanned before publication. Never distribute `.env` files, runtime data, user agent profiles, recordings, a personal app bundle, or private Git history.

Private integration evidence: `npm test` passed 395 unit tests plus 118 property tests. On the public Next.js 16.3.8 checkout, 392 unit tests and 118 property tests passed, the production build passed, Chromium passed 79 with one expected native-wrapper-only skip, and the 11 selected new-flow WebKit checks passed. The synthetic PTT fixture waits for actual encoded audio before releasing send-path gestures and separately verifies short presses do not send; a parallel fixture stress check passed 35/35. These tests use real browser recording with generated audio and mocked recognition/chat services.

The 16.3.6 Next.js dependency audit reported one high advisory and five additional advisories. Updating to 16.3.8 reduced the audit to zero. [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) concerns `remotePatterns`; Panel does not configure that feature, so the prior audit result is not evidence that Panel exposed the vulnerable configuration.

## Live evidence and limits

An isolated real-provider probe on October 6 used DeepSeek Flash for spoken, written, and agent-list turns in the same native conversation. It returned a two-sentence plain spoken answer, a structured written answer, and a native `panel_agents` tool call. A separate saved-agent task was started through the actual Python tool and returned a completed result; status from the wrong parent conversation was rejected. The profile's SOUL, working directory, and selected model matched the native runtime.

Those four test turns took approximately 7.1, 2.6, 3.8, and 4.3 seconds respectively. They are individual observations, not latency guarantees. The first two startup-only attempts in a fresh test Hermes home triggered native first-run packaging; the embedded launcher now disables lazy installs and resolves the installed managed interpreter while retaining dependency activation. Actual model/provider availability still depends on each user's configuration.

On October 7, a separate isolated live-provider run exercised the complete no-tools custom-tab planner path: two natural requirement turns, **Prepare plan**, and the approved build completed in approximately 10.5, 8.5, 4.1, and 3.5 seconds. The result contained four valid Panel-native blocks and produced zero tool calls and zero tool events. The compatibility fallback for a provider that ignores the requested `panel-plan` fence is restricted to authoritative prepare-plan review runs; normal conversation still requires `panel-plan`. This verifies one planner/build path, not arbitrary generated applications or a provider-backed custom-tab action.

The installed legacy app was observed still showing the old octopus identity before replacement. Integration replaced `/Applications/Hermes Control.app` with the fresh `/Applications/Panel.app`, retained the old bundle as a backup, verified the new bundle's ad hoc signature, restarted the private LaunchAgent with the 16.3.8 build, matched its API build identity, and observed the Panel shell open the localhost workspace. Six configuration fingerprints and 99 history fingerprints remained unchanged. This is evidence for the tested Mac only; the bundle is not notarized, is excluded from the public source export, and was not clean-installed on a second Mac.

Physical microphone/speaker latency and a prolonged hands-free conversation were not verified by these probes. Real Jev routing, a provider-backed reviewed custom-tab action, Discord delivery, public notarization, and a clean installation on a second Mac were not tested. These limits prevent a claim that every provider, voice setup, or installation works without errors. Transcript persistence, interruption handling, and browser microphone lifecycle tests are separate from audible end-to-end validation.
