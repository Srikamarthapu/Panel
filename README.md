# Panel

A local workspace for Hermes agents. Talk or type, run independent conversations side by side, and queue work for later. Choose the orb or Bloub as your agent's presence; Bloub follows your pointer while idle.

Panel's first runtime is **Hermes Agent**. You choose the models and providers in Hermes setup; Panel is not tied to one LLM. Hermes supplies sessions, tools, permissions, and execution. Direct LLM-only chat and other agent runtimes are not implemented.

## Run on your Mac

Requirements: macOS, Node.js 22 or newer, and a configured [Hermes Agent](https://github.com/NousResearch/hermes-agent) installation. Install Hermes using its official instructions, then run `hermes setup` and verify `hermes --version`. Panel has been tested with Hermes `v0.21.5+2142.g085d9ee`; its native turn-report contract is checked by the doctor. Hermes updates may change integration compatibility.

Clone Panel, then install and build it:

```sh
git clone https://github.com/Srikamarthapu/Panel.git
cd Panel
npm ci
npm run setup
npm start
```

Open **http://127.0.0.1:3000**. The server binds only to your computer. If that port is occupied, use `npm start -- --port 3010`. Stop it with Ctrl+C. For source development use `npm run dev`.

`npm run doctor` checks your local installation without contacting model providers or printing credentials. If Hermes lives elsewhere, set `HERMES_HOME`, `HERMES_REPO`, and/or `HERMES_CLI_PATH` in your shell or `.env.local`. Keep that file private. Configuring a model does not by itself prove the provider works: test a small message in Chat.

## Work in Panel

- **Sessions**: create a named conversation and optionally choose an existing working folder. Talk and Chat share that session. Rename, pin, archive, and restore sessions; unsent drafts stay with their own conversation. Change folders when the session has no active or scheduled work.
- **Agents**: open the side panel in Chat when you need parallel work. Create an agent session, give it a task, then switch once the server accepts the request. Up to four requests can run at once, with individual status and Stop controls. Conversations have separate context; agents using the same folder still share its files and your account permissions. Panel does not create isolated worktrees or automatically delegate a prompt.
- **Tasks**: queue a request for a session, optionally choosing a future start time. Results stay in that session and task history. Stop a queued or running task from the queue.
- **Tools**: search installed skills and plugin manifests, and inspect runtime setup. Plugin settings and installation are managed by Hermes. An installed manifest is not proof that a plugin loaded successfully.
- **Models**: choose your main, backup, or Talk & Chat model from connected providers. Saved assignments stay visible; discovery-only and unavailable entries are kept out of the default choices. Test a supported model explicitly with a small prompt, or refresh its provider's model list without sending a prompt. See [model availability](docs/model-catalog.md) for what each status means. Chat uses the Hermes CLI; the Discord gateway is not required.
- **Appearance**: choose Orb or Bloub, a companion color, full or reduced motion, cursor following, larger text, and conversation spacing. Choices apply immediately across Talk and Chat and sync between windows on this device. System motion follows your Mac's accessibility preference by default.

`npm start` and `npm run dev` supervise the task worker alongside the app. **Panel and your computer must remain running for scheduled work.** Closing the browser is fine. Tasks waiting while the app is stopped become eligible when it restarts; uncertain interrupted work is marked for attention, not automatically repeated. The queue runs one task at a time. Interactive permission requests may require your attention rather than completing unattended.

Upgrading an earlier local installation? Its browser conversation is adopted as **Previous conversation**, using the same Hermes session ID. The old browser copy is retained, and an existing selected Panel session stays selected. Keep each installation's data and environment files separate from the source distribution.

## Add voice

Text chat works without voice credentials.

```sh
[ -e .env.local ] || cp .env.example .env.local
```

This leaves an existing `.env.local` unchanged. Add `DEEPGRAM_API_KEY` for speech recognition. For speech playback, either add `ELEVENLABS_API_KEY` or install `edge-tts` in the Hermes Python environment. Restart Panel after editing environment variables. Choose audio devices and playback settings in **Voice settings**. Talk starts in **Push to talk** mode: hold the button (or Space/Enter while it is focused), speak, and release to send. Releasing while the microphone is still opening cancels that attempt. Losing focus or cancelling a press discards the recording. Choose **Hands-free** to start a continuous conversation. The browser requests microphone permission on your first microphone action.

Audio sent for recognition goes to Deepgram. Spoken text goes to the chosen speech provider. Short contextual acknowledgements describe intended work; completed actions are reported only from runtime results. You can stop a request, and interruptions remain visible rather than becoming empty successful answers.

## Optional Jev routing

Jev is optional. With it disabled or unavailable, the configured Hermes model continues normally.

1. Register the plugin using Hermes's Python environment. This standalone installer reads exported shell variables, not `.env.local`. If your custom `HERMES_HOME` or `HERMES_REPO` is saved only in `.env.local`, first export those same path values in your shell. The defaults below apply otherwise:
   ```sh
   export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
   export HERMES_REPO="${HERMES_REPO:-$HERMES_HOME/hermes-agent}"
   "$HERMES_REPO/venv/bin/python" scripts/voice/install-jev-runtime.py
   ```
2. Open **Models → Jev routing**, enter your TypeSafe key, and enable the desired routing modes.
3. Control model choice runs only when Talk/Chat follows the Hermes primary model; a saved provider or model remains authoritative. This installer does not patch Hermes gateway files. An optional Discord adapter can be installed separately with `--discord`; Discord is outside this release's validation.

Control model routing selects among the primary model and eligible same-provider fallbacks. It does not infer which arbitrary provider or unconfigured model is best. Jev receives the current prompt and relevant tool/context data through TypeSafe; see [the integration contract](docs/jev.md) for scope and fallback behavior.

## Local data and safety

- Your Hermes credentials remain in your own Hermes installation. Panel's optional keys live in `.env.local`, local voice settings, or Hermes's local Jev settings. None are included in the source distribution.
- Named conversations, transcripts, task schedules, run receipts and voice settings live under `data/` (or `PANEL_DATA_DIR`). Hermes maintains the underlying agent sessions. The browser stores the selected session, appearance and unsent drafts. Local users with filesystem access can read local state.
- Keep Panel on loopback. It is a single-user local app, not a hosted multi-user service. The API rejects foreign browser origins and non-loopback hosts.
- Stopping a request does not undo actions that already finished. Check results before retrying a write operation.
- Source exports exclude all local state and credentials. Keep your data directory private and back it up separately from source.

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
