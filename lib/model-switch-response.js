import { getDirectConfig } from "./direct-config.js";
import { mainSwitchConflicts, resolveModelFor } from "./model-resolver.js";
import { getVoiceConfig } from "./voice.js";

export function modelSwitchResponse(result, role) {
  if (role !== "primary") return result;
  const voiceConfig = getVoiceConfig();
  const directConfig = getDirectConfig();
  const resolutions = {
    chat: resolveModelFor({ surface: "chat", directConfig, voiceConfig }),
    talk: resolveModelFor({ surface: "talk", directConfig, voiceConfig }),
  };
  const option = result?.option || result?.current || {};
  const main = { provider: option.provider || resolutions.chat.requestedProvider, model: option.model || resolutions.chat.requestedModel };
  return {
    ...result,
    conflicts: directConfig.executionMode === "direct" ? [] : mainSwitchConflicts(main, voiceConfig.modelPreferences),
    resolutions,
  };
}
