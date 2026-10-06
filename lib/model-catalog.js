import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { dataDirectory } from "./work-store.js";
import { modelProbeKey, readModelProbeEvidence, runConnectionProbe, saveModelProbeEvidence } from "./model-probes.js";

const root = process.cwd();
const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const repo = process.env.HERMES_REPO || path.join(home, "hermes-agent");
const python = path.join(repo, "venv", "bin", "python");
const bridge = path.join(root, "scripts", "models", "hermes-catalog.py");
const voicePath = path.join(dataDirectory(), "voice-config.json");
let cache = null;
let pending = null;
const activeProbes = new Map();
let providerCredentialRevisions = {};

function withProbeEvidence(catalog) {
  const evidence = readModelProbeEvidence({ credentialRevisions: providerCredentialRevisions });
  return { ...catalog, providers: catalog.providers.map(provider => ({ ...provider, models: provider.models.map(model => {
    const probe = evidence[modelProbeKey(provider.id, model.id)];
    return { ...model, ...(probe ? { probe } : {}) };
  }) })) };
}

function revision() {
  return [path.join(home, "config.yaml"), path.join(home, ".env"), path.join(home, "auth.json"), path.join(home, "provider_models_cache.json"), voicePath].map(file => {
    try { const stat = fs.statSync(/*turbopackIgnore: true*/ file); return `${stat.mtimeMs}:${stat.size}`; } catch { return "missing"; }
  }).join("|");
}

function parseBridge(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error("Hermes model setup returned an unreadable response."); }
  if (result.ok === false) throw new Error(result.error || "Hermes model setup is unavailable.");
  return result;
}

function invokeBridge(input, timeout = 12_000) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, [bridge], { cwd: root, env: { ...process.env, HERMES_HOME: home, HERMES_REPO: repo }, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) {
        if (error.killed || error.code === "ETIMEDOUT") return reject(new Error("The local Hermes model catalog exceeded its time limit. Try again when the Hermes environment is responsive."));
        if (error.code === "ENOENT") return reject(new Error("Hermes's local Python environment could not be found. Check the Hermes installation path and run npm run doctor."));
        return reject(new Error("Hermes's local model catalog could not be read. Run npm run doctor for local compatibility details."));
      }
      try { resolve(parseBridge(stdout)); } catch (failure) { reject(failure); }
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

function readVoiceSelection() {
  try {
    const data = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ voicePath, "utf8"));
    return { provider: data.voiceModelProvider || "", model: data.voiceModel || "", usesDefault: !data.voiceModel };
  } catch { return { provider: "", model: "", usesDefault: true }; }
}

// Whitelist the browser payload. Registry fields, provider headers, endpoints,
// pool records and credential resolver results are server-only.
export function sanitizeModelCatalog(input, voice = { provider: "", model: "", usesDefault: true }) {
  const selection = (value) => ({ provider: String(value?.provider || ""), model: String(value?.model || "") });
  const fallback = Array.isArray(input.current?.fallback) ? input.current.fallback[0] : input.current?.fallback;
  const current = { ...selection(input.current), fallback: selection(fallback) };
  const providers = (Array.isArray(input.providers) ? input.providers : []).map(row => ({
    id: String(row.id || ""), label: String(row.label || row.id || ""),
    configured: Boolean(row.configured), savedLocally: Boolean(row.savedLocally), authType: String(row.authType || ""),
    supportsCatalog: Boolean(row.supportsCatalog), supportsCustomModel: Boolean(row.supportsCustomModel),
    supportsProbe: Boolean(row.supportsProbe),
    ...(!row.supportsProbe && row.configured ? { probeNote: "This provider is tested through Hermes's own runtime. Send it a normal conversation." } : {}),
    // Talk and Chat both use Hermes, including its OAuth and native providers.
    canUseForVoice: Boolean(row.configured), catalogStatus: String(row.catalogStatus || "local"),
    ...(row.catalogNote ? { catalogNote: String(row.catalogNote).slice(0, 260) } : {}),
    ...(row.catalogError ? { catalogError: String(row.catalogError).slice(0, 220) } : {}),
    source: "Hermes setup",
    models: (Array.isArray(row.models) ? row.models : []).map(model => ({ id: String(model.id || ""), label: String(model.label || model.id || ""), source: String(model.source || "hermes-catalog"), availability: String(model.availability || "unverified"), ...(model.availabilityNote ? { availabilityNote: String(model.availabilityNote).slice(0, 180) } : {}), ...(model.available === false ? { available: false } : {}) })).filter(model => model.id),
  })).filter(row => row.id);
  return {
    ok: true, generatedAt: new Date().toISOString(), current,
    voice: { ...selection(voice), usesDefault: Boolean(voice.usesDefault) },
    ...(input.degraded ? { degraded: true } : {}),
    ...(input.registryStatus ? { registryStatus: String(input.registryStatus).slice(0, 40) } : {}),
    ...(input.warning ? { warning: String(input.warning).slice(0, 300) } : {}),
    providers,
  };
}

export async function getModelCatalog({ refresh = false, provider = "" } = {}) {
  const currentRevision = revision();
  if (!refresh && cache && cache.revision === currentRevision && Date.now() - cache.at < 60_000) {
    return withProbeEvidence({ ...cache.value, voice: readVoiceSelection() });
  }
  if (!refresh && pending) return pending;
  const read = invokeBridge({ action: "catalog", refresh, provider, voice: readVoiceSelection() }, refresh ? 15_000 : 12_000).then(raw => {
    providerCredentialRevisions = Object.fromEntries(Object.entries(raw.providerCredentialRevisions || {}).filter(([id, value]) => /^[A-Za-z0-9_.:-]{1,120}$/.test(id) && typeof value === "string" && /^[a-f0-9]{64}$/.test(value)));
    const value = sanitizeModelCatalog(raw, readVoiceSelection());
    // A targeted refresh must not erase successful catalogs from other providers.
    if (provider && cache?.revision === currentRevision) {
      value.providers = value.providers.map(row => row.id === provider ? row : cache.value.providers.find(previous => previous.id === row.id) || row);
    }
    // A credential/config change during the bridge read must force another
    // read, rather than marking the older snapshot as the new file revision.
    cache = { value, revision: currentRevision, at: Date.now() };
    return withProbeEvidence(value);
  });
  if (refresh) return read;
  pending = read.finally(() => { pending = null; });
  return pending;
}

export function validateModelSelection(catalog, { provider, model, role = "primary" }) {
  if (!["primary", "fallback", "voice"].includes(role)) throw new Error("Choose primary, fallback, or voice.");
  if (role === "voice" && !provider && !model) {
    return null;
  }
  if (typeof model !== "string" || !model || model.length > 200 || /[\s\u0000-\u001f\u007f]/.test(model)) throw new Error("Enter a model ID without spaces, up to 200 characters.");
  if (typeof provider !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(provider)) throw new Error("Choose a provider from your Hermes setup.");
  const row = catalog.providers.find(item => item.id === provider);
  if (!row?.configured) throw new Error("This provider is not configured in Hermes. Connect it with hermes model first.");
  const entry = row.models.find(item => item.id === model);
  if (entry?.available === false) throw new Error(entry.availabilityNote || "This model is unavailable for new selections. Choose another model.");
  if (!row.supportsCustomModel && !row.models.some(item => item.id === model)) throw new Error("Choose a model from this provider's Hermes catalog.");
  return row;
}

export async function saveModelSelection(input) {
  const catalog = await getModelCatalog();
  if (catalog.degraded) throw new Error(catalog.warning || "Hermes model setup is read-only until the local compatibility issue is resolved.");
  if (input.provider != null && typeof input.provider !== "string" || input.model != null && typeof input.model !== "string") throw new Error("Choose a provider and enter its model ID.");
  const provider = (input.provider || "").trim();
  const model = (input.model || "").trim();
  const role = input.role || "primary";
  validateModelSelection(catalog, { provider, model, role });
  let result;
  if (role === "voice") {
    if (provider || model) await invokeBridge({ action: "validate", provider, model });
    const { saveVoiceConfig } = await import("./voice.js");
    saveVoiceConfig({ voiceModelProvider: provider, voiceModel: model });
    result = { ok: true, option: { provider, model, label: model || "Hermes default" }, message: model ? "Talk and Chat model saved." : "Talk and Chat follow the Hermes default." };
  } else {
    result = await invokeBridge({ action: "switch", provider, model, role });
  }
  cache = null;
  return result;
}

export async function probeModelSelection(input, { signal } = {}) {
  const catalog = await getModelCatalog();
  if (catalog.degraded) throw new Error(catalog.warning || "Hermes setup is unavailable for model tests.");
  const provider = typeof input.provider === "string" ? input.provider.trim() : input.provider;
  const model = typeof input.model === "string" ? input.model.trim() : input.model;
  const row = validateModelSelection(catalog, { provider, model });
  if (!row.supportsProbe) throw new Error(row.probeNote || "Test this provider with a normal Hermes conversation.");
  const key = modelProbeKey(provider, model);
  if (activeProbes.has(key)) return activeProbes.get(key);
  if (activeProbes.size >= 3) { const error = new Error("Three model tests are already running. Wait for one to finish."); error.status = 429; throw error; }
  const revisionBefore = providerCredentialRevisions[provider];
  const probe = (async () => {
    let connection;
    try { connection = await invokeBridge({ action: "resolve_probe", provider, model }, 8_000); }
    catch { throw new Error("Hermes could not resolve this provider's connection. Check its setup with hermes model."); }
    const result = await runConnectionProbe(connection, { signal });
    await getModelCatalog();
    // A concurrent provider/account change invalidates this result immediately.
    if (!signal?.aborted && revisionBefore && revisionBefore === connection.credentialRevision && revisionBefore === providerCredentialRevisions[provider]) saveModelProbeEvidence(result, { credentialRevision: revisionBefore });
    return result;
  })().finally(() => { activeProbes.delete(key); });
  activeProbes.set(key, probe);
  return probe;
}

// Called only on the server when a direct voice turn needs credentials. Never
// serialize this return value into catalog/configuration endpoint responses.
export function resolveHermesVoiceConnection(provider, model) {
  try {
    const stdout = execFileSync(python, [bridge], { cwd: root, env: { ...process.env, HERMES_HOME: home, HERMES_REPO: repo }, input: JSON.stringify({ action: "resolve", provider, model }), encoding: "utf8", timeout: 8_000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    return parseBridge(stdout);
  } catch {
    const error = new Error("The selected voice model could not resolve its Hermes connection. Choose a configured provider with direct voice support.");
    error.code = "voice_model_config";
    throw error;
  }
}
