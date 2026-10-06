// Reasoning choices are stable; model choices come from the Hermes catalog API.
export const VOICE_REASONING_OPTIONS = [
  { id: "none", label: "None" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

export function voiceModelLabel(config = {}) {
  return config.voiceModel
    ? `${config.voiceModelProvider || "auto"} / ${config.voiceModel}`
    : "Hermes default";
}
