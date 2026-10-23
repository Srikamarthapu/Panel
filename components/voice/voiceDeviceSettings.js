const ACTIVE_MICROPHONE_STATES = new Set(["starting", "capturing", "listening"]);

export function microphoneCaptureActive(voice) {
  return Boolean(
    voice?.continuousRequested ||
    voice?.permission === "pending" ||
    ACTIVE_MICROPHONE_STATES.has(voice?.state),
  );
}

export function savedDeviceStatus({ kind, selectedId, devices, enumerationStatus, permission }) {
  if (!selectedId) return { missing: false, unavailable: false, label: "" };
  if (devices.some((device) => device.deviceId === selectedId)) {
    return { missing: false, unavailable: false, label: "" };
  }

  const noun = kind === "speaker" ? "speaker" : "microphone";
  if (enumerationStatus === "checking") {
    return { missing: true, unavailable: false, label: `Saved ${noun} (checking availability)` };
  }
  if (enumerationStatus !== "ready") {
    return { missing: true, unavailable: false, label: `Saved ${noun} (availability not checked)` };
  }
  if (permission !== "granted") {
    return { missing: true, unavailable: false, label: `Saved ${noun} (not currently listed)` };
  }
  return { missing: true, unavailable: true, label: `Saved ${noun} (unavailable)` };
}
