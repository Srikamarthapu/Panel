# Release checks

Panel 0.3.0 is a macOS-first local source release candidate. Hermes is the supported agent runtime; direct LLM-only execution and native packaging are not implemented. Personal desktop installations keep their own configuration and data, separate from this source copy.

## Current review

Version 0.3.0 adds explicit push-to-talk and hands-free modes; guarded native listener teardown and microphone startup; session pin/archive/restore and folder editing; and an optional Agents panel with four concurrent requests. Session switching waits for server acceptance. Chat uses a smaller header and composer, compact message actions, and activity scoped to its own session/run. Startup and recovery states use the same visual language.

The public app now provides named, persistent sessions; a durable scheduled task queue; a local skills/plugin inventory; compatible model discovery; and guarded voice preparation and pointer-aware Bloub. Appearance controls apply across the interface without interrupting work. Bloub reuses its SVG structure while animating and follows display refresh during pointer movement. The Models page separates saved assignments from connection and test evidence, shows connected providers first, and supports an explicit bounded model test. Legacy dashboard destinations redirect to the relevant workspace pages, and their obsolete APIs are retired.

Verification evidence is recorded in [the rework ledger](docs/harness-rework.md). The review covers terminal errors, session separation, task retry idempotency, cancellation, interrupted execution, and queue restart behavior. Source exports exclude local state and original repository history.

## Release boundaries

- Panel and the computer must stay running for scheduled work. Browser closure is supported; sleep/offline execution is not promised.
- Model catalogs distinguish configured selections, available choices, and explicit test results. Catalog discovery alone is not a guarantee of inference access. Test evidence expires and resets after connection changes; native login providers use a normal Hermes conversation for testing. Local catalog reads do not refresh provider credentials.
- The 0.3.0 production text check was accepted in 52 ms and completed correctly in 15.5 seconds, with Jev activity recorded and both messages saved. Earlier task checks took approximately 20–28 seconds. These are individual measurements; final answer time still depends on the provider and request.
- Voice lifecycle, keyboard/pointer gestures, rapid release during startup, and permission/cancellation paths have browser fixture coverage using synthetic audio streams. Physical microphone/speaker latency and a longer natural conversation soak remain unverified. Do not describe voice as consistently instant.
- Jev is optional and bounded. The live model-routing check selected the configured fast model at 0.99 confidence: 226 ms for Jev, 496 ms including the local bridge. This is one successful check, not a latency guarantee.
- Concurrent sessions have independent context but share account permissions and any common working folder. The queue remains serial; four is a cap on active requests, not a sandbox guarantee.
- Discord delivery, a second clean Mac, and a signed/notarized installer are not validated.

## Repeat the checks

```sh
npm test
npm run test:e2e
npm run test:smoke
npm run test:runtime  # needs the installed Hermes Python environment
npm run build
npm audit --omit=dev
```

CI installs Python and PyYAML for metadata tests. `npm run doctor` checks local compatibility without model requests; it does not validate provider credentials. Live checks consume provider usage and are separate from CI.

Run `node scripts/release/export.mjs /new/path/Panel` to create a source-only copy. Then run `node scripts/release/check.mjs /new/path/Panel`, inspect its manifest, and compare it against locally saved credentials before publishing. Do not publish a development directory, personal built app, data folder, or private repository history. The pattern scanner alone cannot prove that every form of private data is absent.
