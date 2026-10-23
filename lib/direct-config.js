import path from "node:path";
import { dataDirectory, inputError, readJson, withFileLock, writeJson } from "./work-store.js";

export const DIRECT_CONFIG_VERSION = 1;
export const EXECUTION_MODES = Object.freeze(["hermes", "direct"]);

// Destinations are code-owned and deliberately not configurable. Provider
// credentials can therefore only be sent to this small HTTPS allowlist.
export const DIRECT_PROVIDERS = Object.freeze({
  openai: Object.freeze({ id: "openai", label: "OpenAI", origin: "https://api.openai.com", modelsPath: "/v1/models", chatPath: "/v1/chat/completions", envKey: "OPENAI_API_KEY" }),
  openrouter: Object.freeze({ id: "openrouter", label: "OpenRouter", origin: "https://openrouter.ai", modelsPath: "/api/v1/models", chatPath: "/api/v1/chat/completions", envKey: "OPENROUTER_API_KEY" }),
  deepseek: Object.freeze({ id: "deepseek", label: "DeepSeek", origin: "https://api.deepseek.com", modelsPath: "/models", chatPath: "/chat/completions", envKey: "DEEPSEEK_API_KEY" }),
});

const configFile = (directory = dataDirectory()) => path.join(directory, "direct-provider.json");
const clean = (value, label, limit) => {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw inputError(`${label} is invalid.`);
  return value.trim();
};
const providerDefinition = value => {
  const id = clean(value, "Provider", 80);
  const provider = Object.hasOwn(DIRECT_PROVIDERS, id) ? DIRECT_PROVIDERS[id] : null;
  if (!provider) throw inputError("Choose a supported direct provider.");
  return provider;
};

function normalizeStored(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const provider = typeof source.provider === "string" && Object.hasOwn(DIRECT_PROVIDERS, source.provider) ? source.provider : "";
  const model = typeof source.model === "string" && source.model.length <= 300 && !/[\u0000-\u001f\u007f]/.test(source.model) ? source.model.trim() : "";
  const credentials = {};
  for (const id of Object.keys(DIRECT_PROVIDERS)) {
    const apiKey = source.credentials?.[id]?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim() && apiKey.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(apiKey)) credentials[id] = { apiKey: apiKey.trim() };
  }
  return {
    version: DIRECT_CONFIG_VERSION,
    executionMode: EXECUTION_MODES.includes(source.executionMode) ? source.executionMode : "hermes",
    provider,
    model,
    credentials,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

export function getDirectConfig({ directory = dataDirectory() } = {}) {
  return normalizeStored(readJson(configFile(directory), {}));
}

function keyFor(config, provider) {
  return config.credentials[provider.id]?.apiKey || cleanEnvironmentKey(process.env[provider.envKey]);
}

function cleanEnvironmentKey(value) {
  return typeof value === "string" && value.trim() && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";
}

export function publicDirectConfig(config = getDirectConfig()) {
  return {
    executionMode: config.executionMode,
    provider: config.provider,
    model: config.model,
    ready: Boolean(config.provider && config.model && keyFor(config, DIRECT_PROVIDERS[config.provider])),
    providers: Object.values(DIRECT_PROVIDERS).map(provider => ({
      id: provider.id,
      label: provider.label,
      configured: Boolean(keyFor(config, provider)),
      keySource: config.credentials[provider.id]?.apiKey ? "saved" : cleanEnvironmentKey(process.env[provider.envKey]) ? "environment" : null,
    })),
  };
}

export function saveDirectConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw inputError("Direct connection settings are required.");
  return withFileLock(configFile(), () => {
    const current = getDirectConfig();
    const next = { ...current, credentials: { ...current.credentials } };
    if (Object.hasOwn(input, "executionMode")) {
      if (!EXECUTION_MODES.includes(input.executionMode)) throw inputError("Choose Hermes or direct API execution.");
      next.executionMode = input.executionMode;
    }
    if (Object.hasOwn(input, "provider")) {
      const provider = providerDefinition(input.provider);
      if (provider.id !== current.provider && !Object.hasOwn(input, "model")) next.model = "";
      next.provider = provider.id;
    }
    const credentialProvider = Object.hasOwn(input, "credentialProvider")
      ? providerDefinition(input.credentialProvider)
      : Object.hasOwn(input, "provider") ? providerDefinition(input.provider) : next.provider ? DIRECT_PROVIDERS[next.provider] : null;
    if (Object.hasOwn(input, "apiKey")) {
      if (!credentialProvider) throw inputError("Choose a provider before saving an API key.");
      const apiKey = clean(input.apiKey, "API key", 4096);
      if (!apiKey || /\s/.test(apiKey)) throw inputError("Enter an API key without spaces or line breaks.");
      next.credentials[credentialProvider.id] = { apiKey };
    }
    if (input.clearKey === true) {
      if (!credentialProvider) throw inputError("Choose a provider before removing its API key.");
      delete next.credentials[credentialProvider.id];
    } else if (Object.hasOwn(input, "clearKey") && input.clearKey !== false) throw inputError("clearKey must be true or false.");
    if (Object.hasOwn(input, "model")) next.model = clean(input.model, "Model ID", 300);
    if (next.executionMode === "direct") {
      if (!next.provider) throw inputError("Choose a direct provider before enabling direct mode.");
      if (!next.model) throw inputError("Choose or enter a model ID before enabling direct mode.");
      if (!keyFor(next, DIRECT_PROVIDERS[next.provider])) throw inputError(`Save a ${DIRECT_PROVIDERS[next.provider].label} API key before enabling direct mode.`);
    }
    next.updatedAt = new Date().toISOString();
    writeJson(configFile(), next);
    return next;
  });
}

export function resolveDirectConnection({ provider: requestedProvider = "", model: requestedModel = "" } = {}) {
  const config = getDirectConfig();
  if (config.executionMode !== "direct") throw inputError("Direct API mode is not enabled.", 409);
  if (Boolean(requestedProvider) !== Boolean(requestedModel)) throw inputError("A direct model assignment must include both provider and model.", 409);
  const provider = providerDefinition(requestedProvider || config.provider);
  const model = clean(requestedModel || config.model, "Model ID", 300);
  if (!model) throw inputError("Choose a model in Settings before starting a direct request.", 409);
  const apiKey = keyFor(config, provider);
  if (!apiKey) throw inputError(`Save a ${provider.label} API key in Settings before starting this request.`, 409);
  return { provider, model, apiKey };
}

export function resolveDirectProvider(providerId) {
  const config = getDirectConfig();
  const provider = providerDefinition(providerId);
  const apiKey = keyFor(config, provider);
  if (!apiKey) throw inputError(`Save a ${provider.label} API key in Settings before loading its models.`, 409);
  return { provider, apiKey };
}

export function directModeEnabled() {
  return getDirectConfig().executionMode === "direct";
}
