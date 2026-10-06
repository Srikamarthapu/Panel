// Local appearance preferences never touch agent, model, or credential settings.
export const INTERFACE_PREFERENCES_KEY = "panel.interface.preferences";
export const INTERFACE_PREFERENCES_EVENT = "panel-interface-preferences-change";
export const INTERFACE_PREFERENCES_VERSION = 1;

export const AVATAR_PALETTES = Object.freeze({
  sage: Object.freeze({ label: "Sage", color: "#d7e4db", hue: 142, saturation: 24 }),
  blue: Object.freeze({ label: "Sky", color: "#c5daef", hue: 210, saturation: 55 }),
  peach: Object.freeze({ label: "Peach", color: "#eed3bd", hue: 28, saturation: 57 }),
  lilac: Object.freeze({ label: "Lilac", color: "#dcd0ed", hue: 268, saturation: 43 }),
});

export const DEFAULT_INTERFACE_PREFERENCES = Object.freeze({
  version: INTERFACE_PREFERENCES_VERSION,
  motion: "system",
  pointerFollowing: true,
  avatarColor: "sage",
  textSize: "default",
  conversationSpacing: "comfortable",
});

const member = (value, values, fallback) => values.includes(value) ? value : fallback;

export function normalizeInterfacePreferences(value) {
  const defaults = DEFAULT_INTERFACE_PREFERENCES;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value.version !== undefined && value.version !== INTERFACE_PREFERENCES_VERSION)) return { ...defaults };
  return {
    version: INTERFACE_PREFERENCES_VERSION,
    motion: member(value.motion, ["system", "full", "reduced"], defaults.motion),
    pointerFollowing: typeof value.pointerFollowing === "boolean" ? value.pointerFollowing : defaults.pointerFollowing,
    avatarColor: member(value.avatarColor, Object.keys(AVATAR_PALETTES), defaults.avatarColor),
    textSize: member(value.textSize, ["default", "larger"], defaults.textSize),
    conversationSpacing: member(value.conversationSpacing, ["comfortable", "compact"], defaults.conversationSpacing),
  };
}

export function parseInterfacePreferences(serialized) {
  if (typeof serialized !== "string" || serialized.length > 4096) return { ...DEFAULT_INTERFACE_PREFERENCES };
  try { return normalizeInterfacePreferences(JSON.parse(serialized)); }
  catch { return { ...DEFAULT_INTERFACE_PREFERENCES }; }
}

export function getEffectiveReducedMotion(preferences, systemReducedMotion) {
  const { motion } = normalizeInterfacePreferences(preferences);
  return motion === "reduced" || (motion === "system" && Boolean(systemReducedMotion));
}
