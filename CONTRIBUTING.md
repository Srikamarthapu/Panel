# Contributing to Panel

Use Node.js 22+, run `npm ci`, then `npm run dev`. Configure your own Hermes runtime; do not commit credentials, transcripts, recordings, screenshots of private data, generated builds, or files from `data/`.

Keep the boundary between Panel's conversation UI and Hermes's execution adapter explicit. New runtimes should implement the same run states, cancellation, tool-activity, session, and terminal-result contracts; merely changing an API URL is not a runtime integration.

For behavior changes, include a focused regression test. Run `npm test` and `npm run build`; run browser tests for user-flow changes. For Jev, run the Python tests under `runtime/hermes-jev`. Keep provider tests opt-in and use harmless prompts. Respect explicit model selections and fail safely when routing is unavailable.

Document unsupported behavior and compatibility constraints. Report the exact verified surface: local tests, live provider call, browser playback, microphone-to-speaker loop, and real Discord delivery are different checks.
