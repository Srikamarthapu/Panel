// These guards live outside React so press/release ownership is synchronous,
// including two events delivered before React commits the first state update.
export function createPushToTalkGesture() {
  let held = false;
  let restartable = false;
  return {
    begin(view) {
      if (held) return false;
      const available = ["idle", "listening", "speaking", "error"].includes(view.state);
      if (!available && !(restartable && (view.pttRequested || view.state === "starting"))) return false;
      held = true;
      restartable = false;
      return true;
    },
    finish({ startup = false } = {}) {
      if (!held) return false;
      held = false;
      restartable = startup;
      return true;
    },
    isHeld: () => held,
    reset() { held = false; restartable = false; },
  };
}

// Tauri unlisten can reject asynchronously if HMR has already removed its
// listener table entry. Observe both thrown errors and rejected promises;
// never invoke an unlisten handle twice, even if setup resolves after unmount.
export function subscribeNativeVoiceEvent(listen, onToggle) {
  let disposed = false;
  let unlisten = null;
  const disposeHandle = () => {
    const off = unlisten;
    unlisten = null;
    if (typeof off !== "function") return;
    try { void Promise.resolve(off()).catch(() => {}); } catch { /* already removed */ }
  };
  try {
    void Promise.resolve(listen("voice-toggle", (...args) => {
      if (!disposed) onToggle(...args);
    })).then((off) => {
      unlisten = off;
      if (disposed) disposeHandle();
    }).catch(() => {});
  } catch { /* native bridge unavailable */ }
  return () => {
    disposed = true;
    disposeHandle();
  };
}
