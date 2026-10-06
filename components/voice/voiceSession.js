const STORAGE_KEY = "hermes.voice.sessionId";

export function voicePendingRunsKey(sessionId = null) {
  return sessionId ? `hermes.voice.pendingRuns.${encodeURIComponent(sessionId)}` : "hermes.voice.pendingRuns";
}

export function createVoiceSessionId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Keep existing conversation IDs, but give each new profile its own stable ID. */
export function resolveVoiceSessionId(storage, makeId = createVoiceSessionId) {
  try {
    const existing = storage?.getItem(STORAGE_KEY);
    if (typeof existing === "string" && existing.length > 0) return existing;
  } catch {
    // Storage can be disabled in private or embedded browser contexts.
  }

  const id = makeId();
  try {
    storage?.setItem(STORAGE_KEY, id);
  } catch {
    // The caller keeps this ID in a ref for the lifetime of the mount.
  }
  return id;
}
