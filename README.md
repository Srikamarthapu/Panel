# Panel

Panel is a local browser workspace for talking and working with an AI assistant. Type or speak, follow real tool activity, review completed work, and keep conversations, saved teammates, model choices, and custom workspace tabs in one place.

Saved teammates can have their own role, working folder, model, tool and skill policy, and conversation. Start work yourself or let Hermes delegate a well-scoped task to one. Temporary workers and scheduled tasks remain separate. See [agents and voice/text modes](docs/agents.md) for setup, controls, and runtime boundaries.

Panel supports two explicit execution modes. **Hermes Agent** remains the default and supplies tools, permissions, delegation, and workspace planning. **Direct API** mode uses a server-side provider key for durable, streaming conversation without installing Hermes. Direct mode has no tools, file or web access, delegation, or workspace planning; Panel does not present it as Hermes-equivalent execution.

> **Preview status:** `0.6.0-preview.3` is a source release for local use. It has broad automated coverage and bounded real-provider testflight evidence, but it is not a hosted service, signed native app, or guarantee that autonomous work will be professionally finished without review. Provider availability, tool behavior, and output quality still depend on your configuration and the selected model.

## Quick start on macOS

Requirements: macOS and Node.js 22 or newer, plus either a configured [Hermes Agent](https://github.com/NousResearch/hermes-agent) installation or an OpenAI, OpenRouter, or DeepSeek API key. Hermes remains the full-capability route. Panel has been tested with Hermes `v0.21.5+2142.g085d9ee`; its native turn-report contract is checked by the doctor. Hermes updates may change integration compatibility.

From the downloaded or cloned **Panel** directory:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3000**. Panel binds to loopback only. If that port is occupied, use `npm start -- --port 3010`. Stop it with Ctrl+C. For source development use `npm run dev`.

On a computer without Hermes, choose **Connect an API key** in the welcome guide (or open **Settings → Execution**) to save a provider key, load that provider's current model catalog, and choose a model. The key is stored only in Panel's server-side data directory with private file permissions and is never returned by the settings API. Loading models does not run an inference request; sending a Chat or Talk message does consume provider usage.

For Hermes mode, install and configure Hermes first, then run `npm run doctor`. The doctor checks the selected execution mode without contacting model providers or printing credentials. If Hermes lives elsewhere, set `HERMES_HOME`, `HERMES_REPO`, and/or `HERMES_CLI_PATH` in your shell or `.env.local`. Direct provider keys may instead come from `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `DEEPSEEK_API_KEY`, though Settings can save them without an environment file. Configuring or listing a model does not prove inference access: test a small message in Chat when you are ready to consume provider usage.

## Make the workspace your own

Fresh profiles get an optional setup guide. Skip it at any time and reopen it from **Settings → Replay setup guide**. It shows local runtime/model/voice readiness and the exact storage locations; it never asks you to paste credentials.

Use **+ beside Workspace** to plan a custom tab with Hermes. Review the plan, try the preview, then add it to your sidebar. Tabs use native forms, tables, notes, checklists, and actions that show the exact task for approval before Hermes runs it. See [custom workspace tabs](docs/workspace-tabs.md) for capabilities and limits.

Give saved teammates their own colors and they appear in Talk automatically. Use **Hide from Talk** when you do not want one in the companion rail, or **Add to Talk** to bring a hidden teammate back. Presence does not start a task. Their Bloubs show recorded run status; agent profiles expose advanced model, storage, and working-folder details.

Use **Models** to review the saved main, backup, and Talk & Chat assignments. Talk & Chat can follow the main model or pin its own provider and model for future requests; a selected teammate can pin a different model again. Assignment labels and access evidence are separate: **Not tested** or **Access unknown** does not mean a saved choice was removed, and only **Test passed** means that exact model answered Panel's small explicit provider test. Saving a choice does not change a request that is already running.

Completed conversation entries, agent runs, and scheduled tasks can include an expandable **Review work** receipt. It separates the agent's summary from structured tool receipts, reported file locations, available execution evidence, and the requested or runtime-reported model route. A reported file location does not prove the current file contents, and a requested route is not confirmation that the runtime used it. When execution continues after an early answer, stopping it prevents later follow-ups but does not undo actions that already finished.

## Add voice

Text chat works without voice credentials.

```sh
cp .env.example .env.local
```

Add `DEEPGRAM_API_KEY` for speech recognition. For speech playback, either add `ELEVENLABS_API_KEY` or install `edge-tts` in the Hermes Python environment. Restart Panel after editing environment variables. Choose audio devices and playback settings in **Voice settings**. The browser will request microphone permission when you start speaking.

Audio sent for recognition goes to Deepgram. Spoken text goes to the chosen speech provider. Direct API mode does not itself provide speech services: no-Hermes Talk needs Deepgram plus ElevenLabs (or another independently installed supported playback backend). Short contextual acknowledgements describe intended work; completed actions are reported only from runtime results. You can stop a request, and interruptions remain visible rather than becoming empty successful answers.

## Optional Jev routing

Jev is optional. With it disabled or unavailable, the configured Hermes model continues normally.

1. Register the plugin using Hermes's Python environment:
   ```sh
   ~/.hermes/hermes-agent/venv/bin/python scripts/voice/install-jev-runtime.py
   ```
2. Open **Models → Jev**, enter your TypeSafe key, and enable the desired routing modes.
3. Control model choice runs only when Talk/Chat follows the Hermes primary model; a saved provider or model remains authoritative. This installer does not patch Hermes gateway files. An optional Discord adapter can be installed separately with `--discord`; Discord is outside this release's validation.

Control model routing selects among the primary model and eligible same-provider fallbacks. It does not infer which arbitrary provider or unconfigured model is best. Jev receives the current prompt and relevant tool/context data through TypeSafe; see [the integration contract](docs/jev.md) for scope and fallback behavior.

## Local data and safety

- Your Hermes credentials remain in your own Hermes installation. Direct provider keys saved in Settings live in Panel's server-only data directory; environment, voice, and Jev keys remain in their documented local stores. None are included in the source distribution or returned to the browser after saving.
- Saved conversations, agent profiles, tab state, run receipts, and activity live under `data/` (or `PANEL_DATA_DIR`). Browser storage keeps interface choices, selected teammates, and recovery drafts. Hermes also maintains its own sessions. Local users with filesystem access can read local state.
- While an answer streams, Panel records received text locally so Chat can reconnect and replay it. If a direct request fails or is stopped, partial text can remain in the local run stream but is not added to conversation history as a completed assistant answer.
- Keep Panel on loopback. It is a single-user local app, not a hosted multi-user service. The API rejects foreign browser origins and non-loopback hosts.
- Stopping a request does not undo actions that already finished. Check results before retrying a write operation.

## Development and checks

```sh
npm test
npm run test:e2e
npm run test:smoke
npm run build
npm audit --omit=dev
```

`npm test` includes the portable Python adapter checks with an empty Hermes home and repository. Tests that require importing a live installed Hermes runtime are explicitly skipped and are not counted as passes. `npm run test:py:host` is disabled because live Hermes bootstrap can mutate the installed runtime or desktop app; it fails before starting an interpreter until a fully sandboxed fixture exists. Browser tests require Playwright's Chromium: `npx playwright install chromium`. By default they copy the current source without `.env` files, create an isolated production build, and start an owned server with empty runtime/data roots; set `PANEL_TEST_URL` only when intentionally testing an external server. `TURNS=3 npm run test:live` runs real text turns against your local server and configured provider; it consumes provider usage and waits for actual answers. It does not measure physical microphone/speaker latency.

`npm run test:browser-server` exercises the owned server wrapper with a local fake executable, including build interruption and process-group shutdown, without compiling Panel. The real Playwright commands remain the production-build integration check.

The supported distribution is source plus the local browser app. The experimental Tauri wrapper is excluded from this source bundle; no signed or notarized native installer is provided. Do not distribute a personal built `.app` or the original workspace history as a release.

See the [0.6.0-preview.3 notes](docs/release-0.6.0-preview.3.md), [release checks](RELEASE-CHECKS.md), [contributing guide](CONTRIBUTING.md), [security policy](SECURITY.md), and [third-party notices](NOTICE.md). Panel code is MIT licensed; dependency licenses remain with their authors. Panel is an independent project, not an official Hermes or model-provider product.
