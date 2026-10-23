export const DEFAULT_ASSISTANT_RUN_TIMEOUT_MS = 12 * 60_000;

export function assistantRunTimeoutMs(value) {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(DEFAULT_ASSISTANT_RUN_TIMEOUT_MS, Math.max(250, requested))
    : DEFAULT_ASSISTANT_RUN_TIMEOUT_MS;
}
