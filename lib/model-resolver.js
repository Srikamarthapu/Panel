import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { getDirectConfig } from "./direct-config.js";
import { formatModelDisplayName } from "./model-display.js";
import { getVoiceConfig } from "./voice.js";

const SURFACES = new Set(["chat", "talk"]);
const clean = (value, limit) => typeof value === "string" && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : "";

export function inferModelSurface({ surface = "", source = "", textOnly = true } = {}) {
  if (SURFACES.has(surface)) return surface;
  if (source === "talk") return "talk";
  if (source === "workspace" || source === "task") return "chat";
  return textOnly === false ? "talk" : "chat";
}

export function readHermesMainModel({ file = path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "config.yaml") } = {}) {
  try {
    const value = parse(fs.readFileSync(file, "utf8"), { maxAliasCount: 100, uniqueKeys: true });
    if (!value || typeof value !== "object" || Array.isArray(value)) return { provider: "", model: "", resolved: false };
    if (typeof value.model === "string") {
      const model = clean(value.model, 300);
      const provider = clean(value.provider, 120);
      return { provider, model, resolved: Boolean(provider && model) };
    }
    const modelConfig = value.model && typeof value.model === "object" && !Array.isArray(value.model) ? value.model : {};
    const provider = clean(modelConfig.provider, 120);
    const model = clean(modelConfig.default ?? modelConfig.model, 300);
    return { provider, model, resolved: Boolean(provider && model) };
  } catch {
    return { provider: "", model: "", resolved: false };
  }
}

export function friendlyModelName(provider, model) {
  return formatModelDisplayName(model);
}

function publicResolution({ surface, executionMode, provider, model, origin, originLabel, reasoningEffort }) {
  const requestedProvider = clean(provider, 120);
  const requestedModel = clean(model, 300);
  const friendlyName = friendlyModelName(requestedProvider, requestedModel);
  return {
    surface,
    executionMode,
    requestedProvider,
    requestedModel,
    friendlyName,
    label: friendlyName,
    origin,
    originLabel,
    reasoningEffort: clean(reasoningEffort, 40),
    followsMain: origin === "main",
    resolved: Boolean(requestedProvider && requestedModel),
  };
}

export function resolveModelFor({ surface, agent = null, directConfig = getDirectConfig(), voiceConfig = getVoiceConfig(), mainModel = readHermesMainModel() } = {}) {
  if (!SURFACES.has(surface)) throw new Error("Choose Chat or Talk.");
  const preference = voiceConfig.modelPreferences?.[surface] || { mode: "follow-main", provider: "", model: "", reasoningEffort: surface === "talk" ? voiceConfig.voiceReasoningEffort : "" };
  const executionMode = directConfig.executionMode === "direct" ? "direct" : "hermes";
  const agentProvider = clean(agent?.provider, 120), agentModel = clean(agent?.model, 300);
  if (agentProvider || agentModel) {
    const agentName = clean(agent?.name, 120);
    return publicResolution({ surface, executionMode, provider: agentProvider, model: agentModel, origin: "agent", originLabel: agentName ? `${agentName}'s model` : "Agent model", reasoningEffort: preference.reasoningEffort });
  }
  if (executionMode === "direct") {
    return publicResolution({ surface, executionMode, provider: directConfig.provider, model: directConfig.model, origin: "direct", originLabel: "Direct API settings", reasoningEffort: preference.reasoningEffort });
  }
  if (preference.mode === "pin" && preference.provider && preference.model) {
    return publicResolution({ surface, executionMode, provider: preference.provider, model: preference.model, origin: "surface", originLabel: surface === "talk" ? "Pinned for Talk" : "Pinned for Chat", reasoningEffort: preference.reasoningEffort });
  }
  return publicResolution({ surface, executionMode, provider: mainModel.provider, model: mainModel.model, origin: "main", originLabel: "Main model", reasoningEffort: preference.reasoningEffort });
}

export function mainSwitchConflicts(main, preferences = getVoiceConfig().modelPreferences) {
  const mainProvider = clean(main?.provider, 120), mainModel = clean(main?.model, 300);
  if (!mainProvider || !mainModel) return [];
  const mainFriendlyName = friendlyModelName(mainProvider, mainModel);
  return ["chat", "talk"].flatMap(surface => {
    const preference = preferences?.[surface];
    if (preference?.mode !== "pin" || !preference.provider || !preference.model || preference.provider === mainProvider && preference.model === mainModel) return [];
    const name = surface === "talk" ? "Talk" : "Chat";
    const pinnedFriendlyName = friendlyModelName(preference.provider, preference.model);
    return [{
      surface,
      name,
      pinnedProvider: preference.provider,
      pinnedModel: preference.model,
      pinnedFriendlyName,
      mainProvider,
      mainModel,
      mainFriendlyName,
      message: `${name} is pinned to ${pinnedFriendlyName}. Switch ${name} to ${mainFriendlyName} too?`,
    }];
  });
}
