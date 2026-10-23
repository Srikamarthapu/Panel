import { normalizeRunOutcome } from "./run-outcome.js";

export function shouldShowChatOutcome(outcome) {
  const value = normalizeRunOutcome(outcome);
  if (!value) return false;
  if (value.state !== "complete") return true;
  return value.model?.mismatch === true || value.observed.tools.length > 0 || value.observed.files.length > 0 || value.verified.items.length > 0;
}
