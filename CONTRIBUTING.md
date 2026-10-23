# Contributing to Panel

Use macOS with Node.js 22 or newer. Fork or clone the repository, create a focused branch, run `npm ci`, then use `npm run dev`. Configure your own Hermes runtime or Direct API credentials locally; do not commit credentials, transcripts, recordings, screenshots of private data, generated builds, or files from `data/`.

Keep the boundary between Panel's conversation UI and Hermes's execution adapter explicit. New runtimes should implement the same run states, cancellation, tool-activity, session, and terminal-result contracts; merely changing an API URL is not a runtime integration.

For behavior changes, include a focused regression test. Run `npm test` and `npm run build`; run `npm run test:e2e` and `npm run test:smoke` for user-flow changes. Browser checks require Playwright's Chromium (`npx playwright install chromium`). Portable Python checks are part of `npm test`. Installed-Hermes checks are unavailable until the project has a fully sandboxed runtime fixture; `npm run test:py:host` intentionally fails before starting Hermes. For Jev, run the Python tests under `runtime/hermes-jev` only in an isolated compatible environment. Keep provider tests opt-in and use harmless prompts. Respect explicit model selections and fail safely when routing is unavailable.

Keep pull requests narrow. Explain the user-visible change, relevant runtime boundaries, checks run, and known limits. Document unsupported behavior and compatibility constraints. Report the exact verified surface: local tests, a live provider call, browser playback, a microphone-to-speaker loop, and real Discord delivery are different checks.

CI also verifies the reviewed source manifest. After changing release-eligible files, follow the prepare, review, and approve steps in [the source-export gate](RELEASE-CHECKS.md#source-export-gate), inspect the manifest diff, and include the updated `scripts/release/source-files.json` in your pull request. Do not bypass that check or include local runtime data in the manifest.
