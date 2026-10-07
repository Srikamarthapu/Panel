# Panel

Saved teammates can have their own SOUL.md, working folder, model, and conversation. Start work yourself or let Hermes delegate to them. See [agents and voice/text modes](docs/agents.md) for setup, controls, and runtime boundaries.

A local workspace for talking and working with your AI agent. Speak naturally or type, follow real tool activity, and keep the full conversation in one place. Choose the orb or Bloub as your agent's presence.

Panel's first runtime is **Hermes Agent**. You choose the models and providers in Hermes setup; Panel is not tied to one LLM. Hermes supplies sessions, tools, permissions, and execution. Direct LLM-only chat and other agent runtimes are not implemented.

## Run on your Mac

Requirements: macOS, Node.js 22 or newer, and a configured [Hermes Agent](https://github.com/NousResearch/hermes-agent) installation. Install Hermes using its official instructions, then run `hermes setup` and verify `hermes --version`. Panel has been tested with Hermes `v0.21.5+2142.g085d9ee`; its native turn-report contract is checked by the doctor. Hermes updates may change integration compatibility.

From the downloaded or cloned **Panel** directory:

```sh
npm ci
npm run setup
npm start
```

Open **http://127.0.0.1:3000**. The server binds only to your computer. If that port is occupied, use `npm start -- --port 3010`. Stop it with Ctrl+C. For source development use `npm run dev`.

`npm run doctor` checks your local installation without contacting model providers or printing credentials. If Hermes lives elsewhere, set `HERMES_HOME`, `HERMES_REPO`, and/or `HERMES_CLI_PATH` in your shell or `.env.local`. Keep that file private. Configuring a model does not by itself prove the provider works: test a small message in Chat.

## Add voice

Text chat works without voice credentials.

```sh
cp .env.example .env.local
```

Add `DEEPGRAM_API_KEY` for speech recognition. For speech playback, either add `ELEVENLABS_API_KEY` or install `edge-tts` in the Hermes Python environment. Restart Panel after editing environment variables. Choose audio devices and playback settings in **Voice settings**. The browser will request microphone permission when you start speaking.

Audio sent for recognition goes to Deepgram. Spoken text goes to the chosen speech provider. Short contextual acknowledgements describe intended work; completed actions are reported only from runtime results. You can stop a request, and interruptions remain visible rather than becoming empty successful answers.

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

- Your Hermes credentials remain in your own Hermes installation. Panel's optional keys live in `.env.local`, local voice settings, or Hermes's local Jev settings. None are included in the source distribution.
- Conversation history is stored in browser local storage; run receipts and activity live under `data/`. Hermes also maintains its own sessions. Local users with filesystem access can read local state.
- Keep Panel on loopback. It is a single-user local app, not a hosted multi-user service. The API rejects foreign browser origins and non-loopback hosts.
- Stopping a request does not undo actions that already finished. Check results before retrying a write operation.
- Optional legacy workspace views use your own Hermes data and may be empty until configured. They are not bundled sample personal data.

## Development and checks

```sh
npm test
npm run test:e2e
npm run test:smoke
npm run build
npm audit --omit=dev
```

Browser tests require Playwright's Chromium: `npx playwright install chromium`. `TURNS=3 npm run test:live` runs real text turns against your local server and configured provider; it consumes provider usage and waits for actual answers. It does not measure physical microphone/speaker latency.

The supported distribution is source plus the local browser app. The experimental Tauri wrapper is excluded from this source bundle; no signed or notarized native installer is provided. Do not distribute a personal built `.app` or the original workspace history as a release.

See [release checks](RELEASE-CHECKS.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [third-party notices](NOTICE.md). Panel code is MIT licensed; dependency licenses remain with their authors. Panel is an independent project, not an official Hermes or model-provider product.
