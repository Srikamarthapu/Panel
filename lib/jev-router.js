import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readHermesEnv } from "./modelControl.js";

// Browser settings only. Jev inference now runs inside Hermes's llm_execution
// middleware, where it sees the actual tool inventory and latest tool outcome.
const defaults = Object.freeze({ enabled: false, discordEnabled: false, modelRouting: false, toolSelection: true, directDispatch: true, monitorProgress: true, manageContext: true });
const subordinateKeys = Object.keys(defaults).filter(key => key !== "enabled");
const home = () => process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const repository = () => process.env.HERMES_REPO || path.join(home(), "hermes-agent");
const configPath = () => path.join(home(), "control-center", "jev.json");
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8")); } catch { return {}; }
}
function readConfig() {
  const value = readJson(configPath());
  const enabled = typeof value.enabled === "boolean" ? value.enabled : defaults.enabled;
  const preferences = Object.fromEntries(subordinateKeys.map(key => [key,
    typeof value.preferences?.[key] === "boolean" ? value.preferences[key]
      : typeof value[key] === "boolean" ? value[key] : defaults[key],
  ]));
  return { enabled, ...Object.fromEntries(subordinateKeys.map(key => [key, enabled ? preferences[key] : false])), preferences, apiKey: typeof value.apiKey === "string" ? value.apiKey : "" };
}
function credentials(config) {
  const environmentKey = process.env.TYPESAFE_API_KEY || readHermesEnv().TYPESAFE_API_KEY || "";
  return { apiKey: config.apiKey || environmentKey, source: config.apiKey ? "saved" : environmentKey ? "environment" : "none" };
}
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const clean = (value, max = 120) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
function discordModelRouteInstalled() {
  try {
    const repo = repository();
    const hooks = fs.readFileSync(path.join(repo, "hermes_cli", "plugins.py"), "utf8");
    const runner = fs.readFileSync(path.join(repo, "gateway", "run_turn_runner.py"), "utf8");
    return hooks.includes('    "pre_model_route",') &&
      runner.includes("def _route_discord_turn_model(") &&
      runner.includes("model = _route_discord_turn_model(runner, ctx, model, runtime_kwargs)");
  } catch { return false; }
}
export function sanitizeJevRuntime(value = {}) {
  const raw = value.lastDecision || (value.mode ? value : null);
  const mode = ["direct", "forced", "finish", "defer", "fallback", "context", "model"].includes(raw?.mode) ? raw.mode : "fallback";
  const lastDecision = raw ? { at: clean(raw.at, 40), sessionId: clean(raw.sessionId), turnId: clean(raw.turnId), iteration: finite(raw.iteration), mode, tool: clean(raw.tool), selectedModel: clean(raw.model), elapsedMs: finite(raw.elapsedMs), confidence: finite(raw.confidence) !== null && raw.confidence <= 1 ? raw.confidence : null, reason: /^[a-zA-Z0-9_ -]{0,100}$/.test(raw.reason || "") ? raw.reason || "" : "runtime_error", progress: ["continue", "inspect_error", "inspect_callers", "ask_user", "defer"].includes(raw.progress) ? raw.progress : null, skippedFrontier: raw.skippedFrontier === true } : null;
  const metrics = Object.fromEntries(["decisions", "direct", "forced", "fallback", "averageDecisionMs", "providerAttempts", "providerSuccesses", "providerFailures", "providerTimeouts"].map(key => [key, finite(value.metrics?.[key]) ?? 0]));
  const outcome = ["attempt", "success", "failure", "timeout"].includes(value.lastProviderCall?.outcome) ? value.lastProviderCall.outcome : "";
  const lastProviderCall = outcome ? { at: clean(value.lastProviderCall?.at, 40), outcome,
    requestIdHash: /^[a-f0-9]{12}$/.test(value.lastProviderCall?.requestIdHash || "") ? value.lastProviderCall.requestIdHash : "",
    ...Object.fromEntries(["inputTokens", "outputTokens", "totalTokens"].map(key => [key, finite(value.lastProviderCall?.[key])]).filter(([, item]) => item !== null)) } : null;
  const reasons = Object.fromEntries(["uncertain_selection", "needs_hermes_reasoning", "compose_final_answer", "hermes_fills_arguments", "grounded_read_arguments", "progress_checked", "reconsider_failed_strategy", "tools_required_by_host", "provider_thinking_requires_auto", "invalid_choice_schema", "unknown_choice", "missing_confidence", "below_confidence", "incomplete_probabilities", "invalid_probabilities", "diffuse_selection", "inconsistent_selection"].map(key => [key, finite(value.reasons?.[key]) ?? 0]));
  return { version: clean(String(value.version || ""), 30), providerTrackingSince: clean(value.providerTrackingSince, 40), lastDecision, lastProviderCall, metrics, reasons };
}
export function getJevRouterStatus() {
  const config = readConfig();
  const key = credentials(config);
  const runtime = sanitizeJevRuntime(readJson(path.join(home(), "control-center", "jev-runtime.json")));
  const installed = fs.existsSync(path.join(home(), "plugins", "hermes-jev", "plugin.yaml"));
  return { ...Object.fromEntries(Object.keys(defaults).map(option => [option, config[option]])), preferences: config.preferences, configured: Boolean(key.apiKey), keySource: key.source, keySuffix: key.apiKey ? key.apiKey.slice(-4) : "", model: "jev-latest", timeoutMs: 1200, runtime: { ...runtime, installed, discordModelRouteInstalled: discordModelRouteInstalled() } };
}
export function saveJevRouterConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide Jev settings.");
  const current = readConfig();
  for (const key of [...Object.keys(defaults), "removeKey"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error("Provide true or false for each Jev setting.");
  }
  if (input.preferences !== undefined && (!input.preferences || typeof input.preferences !== "object" || Array.isArray(input.preferences))) throw new Error("Provide valid Jev preferences.");
  for (const key of subordinateKeys) if (input.preferences?.[key] !== undefined && typeof input.preferences[key] !== "boolean") throw new Error("Provide true or false for each Jev preference.");
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("Enter a valid TypeSafe API key.");
  const suppliedKey = input.apiKey?.trim() || "";
  if (suppliedKey && (suppliedKey.length < 8 || suppliedKey.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(suppliedKey))) throw new Error("Enter a TypeSafe API key without spaces.");
  const enabled = input.enabled ?? current.enabled;
  const preferences = Object.fromEntries(subordinateKeys.map(key => [key, input.preferences?.[key] ?? input[key] ?? current.preferences[key]]));
  const next = { version: 3, enabled, ...Object.fromEntries(subordinateKeys.map(key => [key, enabled ? preferences[key] : false])), preferences, apiKey: input.removeKey === true ? "" : suppliedKey || current.apiKey };
  if (next.enabled && !credentials(next).apiKey) throw new Error("Add your TypeSafe API key to enable Jev.");
  const destination = configPath();
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(next) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, destination); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  return getJevRouterStatus();
}
