export function createPollBackoff({ baseDelay = 3000, maxDelay = 30000 } = {}) {
  let failures = 0;
  return {
    success() { failures = 0; return baseDelay; },
    failure() { failures += 1; return Math.min(maxDelay, baseDelay * (2 ** (failures - 1))); },
    reset() { failures = 0; },
  };
}

export function startAdaptivePolling({
  poll,
  onError = () => {},
  baseDelay = 3000,
  maxDelay = 30000,
  immediate = true,
  forceInitial = false,
  documentRef = typeof document === "undefined" ? null : document,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof poll !== "function") throw new TypeError("poll must be a function");
  const backoff = createPollBackoff({ baseDelay, maxDelay });
  let stopped = false, running = false, timer = null, queuedForce = false;
  const visible = () => !documentRef || documentRef.visibilityState !== "hidden";
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = delay => {
    clear();
    if (!stopped && visible()) timer = setTimer(() => { timer = null; void run(); }, delay);
  };
  async function run({ force = false } = {}) {
    if (stopped || (!force && !visible())) return;
    if (running) { queuedForce ||= force; return; }
    clear(); running = true;
    let delay = baseDelay;
    try { await poll(); delay = backoff.success(); }
    catch (error) { delay = backoff.failure(); onError(error); }
    finally {
      running = false;
      if (stopped) return;
      if (queuedForce) { queuedForce = false; void run({ force: true }); }
      else schedule(delay);
    }
  }
  const onVisibility = () => {
    clear();
    if (visible()) void run();
  };
  documentRef?.addEventListener?.("visibilitychange", onVisibility);
  if (immediate) void run({ force: forceInitial }); else schedule(baseDelay);
  return {
    refresh(options = {}) { return run(options); },
    stop() { stopped = true; clear(); documentRef?.removeEventListener?.("visibilitychange", onVisibility); },
  };
}
