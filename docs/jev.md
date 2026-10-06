# Jev inside the Hermes agent loop

Jev selects the next actual available tool before each eligible Hermes inference. Control Center and Discord can also ask Jev to choose among configured models before a default-model turn starts. Hermes still owns the conversation, provider setup, tool executor, permission checks, and result storage.

## Setup

The extension lives in `runtime/hermes-jev/`. Run `scripts/voice/install-jev-runtime.py` with the installed Hermes Python environment to register it through Hermes's plugin API. The installer preserves configuration, saves a private backup, and links the plugin into `~/.hermes/plugins/hermes-jev`. It does not patch Hermes by default or grant permission to override built-in tools. The optional `--discord` flag installs the separate gateway extension. Control Center routes a default model before launching its Hermes CLI request. Discord model routing also needs the narrow installed-Hermes hook added by `scripts/voice/install-jev-discord-route.py`; run that installer after Hermes upgrades. It supports `--check` and `--uninstall`.

**Models → Jev inside Hermes** controls tool selection, direct read-only actions, repeated-failure detection, and tool-context selection independently. The existing TypeSafe key is preserved when saving a blank key field. Saved credentials are in the owner-only file `~/.hermes/control-center/jev.json`; `TYPESAFE_API_KEY` is also supported. Neither status responses nor diagnostics return credentials.

Control Center runs set `HERMES_JEV_CONTROL=1`. Discord gateway turns use the separate **Use Jev for Discord** setting, which is checked from the actual `platform` passed by Hermes middleware. Other gateway platforms and ordinary CLI sessions remain outside this scope. The gateway must be restarted after installing or changing plugin registration. Control starts a fresh process for each request and resumes the saved Hermes session.

## Control Center and Discord model choice

When **Choose a model for Discord and Control prompts** is enabled, Jev evaluates a default-model prompt before Hermes starts its turn. Control routes before it launches the CLI; Discord routes before the gateway constructs its agent. Candidates come from the configured primary and up to three same-provider fallbacks whose explicit endpoint and request settings match the primary route. Omitted fallback settings inherit the primary route for Panel; incompatible model-specific wire formats are excluded. A saved Talk/Chat model choice and Discord `/model` override take precedence. Missing credentials, a service failure, a timeout, an invalid choice, or confidence below the threshold leaves the configured model in place. Jev's tool decisions continue inside the selected agent's loop.

Only models already configured for the same provider and compatible with the active provider route are considered. Cross-provider model routing requires additional credential and client resolution and is not enabled here.

## Tool decisions and execution

1. The `llm_execution` middleware reads the actual tool schemas advertised for that iteration, recent visible conversation, and recent tool outcomes.
2. One System One request asks Jev to choose an actual currently available tool, finish the work, or defer to Hermes. This happens afresh for each new user prompt and after tool results; an empty tool catalog is still evaluated as finish-or-defer. Closed argument choices and periodic progress questions are batched with that request.
3. For reviewed read-only tools or tools explicitly annotated read-only, complete arguments can be selected from schema enums/constants/booleans or installed skill names. JSON Schema validation must pass. Hermes then receives a native tool-call response without invoking the frontier model.
4. For open-ended arguments, Jev sets the provider's native tool choice and Hermes generates the arguments. The stable tool catalog remains available. Mutating tools always retain this model step.
5. Hermes validates, records, approves where required, and executes the tool through its normal path. The next iteration sees the actual result. Jev never directly invokes the tool executor.

Direct dispatch works with native Chat Completions, Anthropic Messages, and Responses adapters. Unsupported protocols retain normal Hermes behavior. Anthropic extended/adaptive thinking cannot be combined with a forced tool choice, so that case falls back without changing the user's reasoning settings. Native DeepSeek V4 thinking also rejects required or named tool choice. When Jev confidently selects a concrete tool, the middleware makes a request-local copy, disables thinking only for that argument-filling call, and names the selected tool; saved settings and the original request remain unchanged. A DeepSeek finish decision keeps the original automatic request because the provider may otherwise emit textual tool markup instead of a native validated call. Hermes's execution middleware permits only one downstream provider call, so malformed textual markup is never retried inside Jev middleware. A provider retry with the same request does not repeat the Jev request or replay its rejected choice. Identical direct dispatches are limited to once per turn.

Progress checks use actual recent outcomes and run periodically. A confident finding of stalled work gives Hermes a fixed recovery suggestion immediately, such as inspecting the error or checking prerequisites. It does not autonomously revert changes or authorize a new action.

## Context

The registered `llm_request` middleware applies request-only selection to Chat Completions requests. Jev can keep, shorten, or omit old, complete tool-call/result pairs. System and user instructions, assistant prose, recent messages, known errors, and ambiguous pairs are preserved. Only fully inspected read-only results may be dropped; other actions retain call evidence. The saved conversation and native compression policy remain intact. Decisions are cached, and uncertain answers or service failures leave the request unchanged. Anthropic and Responses keep their native context handling.

Automatic switching between model providers is not part of this integration. The selected provider and its credentials remain owned by Hermes.

## Bounds and visibility

The endpoint is fixed to `https://api.typesafe.ai/v1/systemone`, model `jev-latest`, with a 1.2-second decision deadline and no redirect or immediate retry. Invalid names, arguments, probabilities, confidence, responses, and service failures fall back to Hermes. Repeated transport errors trigger a cooldown.

Enabling this system sends relevant recent conversation, tool summaries, tool descriptions, and bounded candidate values to TypeSafe. Model routing also sends the current Control Center or Discord prompt. Native secret redaction runs before recent content is sent. Provider reasoning blocks and credentials are excluded from the decision state. This is a broader data flow than the old request-only classifier, because each decision needs the latest work state.

The dashboard shows actual decisions, frontier calls skipped, model argument steps, and decision latency. Metadata is written privately to `~/.hermes/control-center/jev-runtime.json`; prompts, arguments, and results are excluded. Activity appears in the **Activity** disclosure, separate from spoken replies and chat text.

Skipping a frontier call is the clearest potential latency saving. Selecting a tool and then asking Hermes for open-ended arguments adds a Jev request; it is not automatically faster. Full task latency still includes runtime startup, model inference, tool execution, transcription, and speech synthesis.

## Evidence

- September 20, 2026 UTC: a bounded live check used the installed middleware, real Jev, and real DeepSeek V4 Flash. Jev selected `lookup_weather` with confidence 1.0 in 265 ms. DeepSeek received that named tool choice with thinking disabled for the argument-filling request and returned the same tool with `{ "city": "London" }`. Total selection plus argument generation was 1,437 ms; DeepSeek used 330 tokens. The original request was unchanged. No tool was executed. This verifies the handoff, not whole-task latency.
- The handoff change passed 21 offline loop checks and 15 context checks, including fresh prompts, zero-tool prompts, uncertainty, direct grounded reads, and provider-specific request changes. The installed plugin loads the changed files directly; no app rebuild or restart was required.
- The saved key returned a valid synthetic tool choice with 0.99 confidence in 348 ms on September 19, 2026. No tools were executed by that check. This is one connection check, not an end-to-end benchmark.
- The installed Hermes plugin loader registered the execution middleware.
- Offline fixtures cover native response adapters, tool choice, argument validation, retries, progress feedback, context preservation, and private settings.
- Live personal-service actions, microphone capture, and complete voice tasks remain user-tested.

## Primary sources

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/): named tool choice requires thinking to be disabled; `none` is supported for finishing.
- [TypeSafe function calling](https://docs.typesafe.ai/cookbooks/function_calling): selecting a function and known argument choices.
- [TypeSafe API](https://docs.typesafe.ai/api): request and response contract.
- [Choice](https://docs.typesafe.ai/primitives/choice) and [confidence](https://docs.typesafe.ai/confidence): bounded outputs and uncertainty.
- [Hermes context engine contract](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/context-engine-plugin.md): request-only context selection and native compression lifecycle.

- September 27, 2026 UTC: the real Control model bridge selected `deepseek-flash` for a simple prompt at confidence 0.97; Jev took 243 ms and the complete bridge took 431 ms. This validates a default-model choice among two configured candidates. A pinned Talk/Chat model bypasses this selection.
