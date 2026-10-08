export const ONBOARDING_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = "panel.onboarding.v1";
export const ONBOARDING_REPLAY_EVENT = "panel:onboarding-replay";
export const ONBOARDING_OUTCOMES = new Set(["completed", "skipped", "existing-user"]);

export function normalizeOnboardingDecision(value) {
  if (!value || typeof value !== "object" || value.version !== ONBOARDING_VERSION || !ONBOARDING_OUTCOMES.has(value.outcome)) return null;
  return {
    version: ONBOARDING_VERSION,
    outcome: value.outcome,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

export function parseOnboardingDecision(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try { return normalizeOnboardingDecision(JSON.parse(raw)); } catch { return null; }
}

export function onboardingReadinessResults(modelResult, voiceResult) {
  const failure = (result, fallback) => result.status === "rejected" ? String(result.reason?.message || fallback) : "";
  return {
    models: modelResult.status === "fulfilled" ? modelResult.value : null,
    voice: voiceResult.status === "fulfilled" ? voiceResult.value : null,
    errors: {
      models: failure(modelResult, "The model check is unavailable right now."),
      voice: failure(voiceResult, "The voice check is unavailable right now."),
    },
  };
}
