import test from "node:test";
import assert from "node:assert/strict";

import { microphoneCaptureActive, savedDeviceStatus } from "../../components/voice/voiceDeviceSettings.js";

test("microphone tests are blocked only while capture can own the input", () => {
  for (const voice of [
    { permission: "pending", state: "idle" },
    { state: "starting" },
    { state: "capturing" },
    { state: "listening" },
    { state: "thinking", continuousRequested: true },
  ]) assert.equal(microphoneCaptureActive(voice), true);

  assert.equal(microphoneCaptureActive({ state: "idle" }), false);
  assert.equal(microphoneCaptureActive({ state: "thinking", continuousRequested: false }), false);
  assert.equal(microphoneCaptureActive({ state: "speaking", continuousRequested: false }), false);
});

test("a saved device is called unavailable only after access-backed enumeration", () => {
  const base = { kind: "microphone", selectedId: "saved", devices: [] };
  assert.deepEqual(savedDeviceStatus({ ...base, enumerationStatus: "checking", permission: "unknown" }), {
    missing: true,
    unavailable: false,
    label: "Saved microphone (checking availability)",
  });
  assert.deepEqual(savedDeviceStatus({ ...base, enumerationStatus: "unavailable", permission: "unknown" }), {
    missing: true,
    unavailable: false,
    label: "Saved microphone (availability not checked)",
  });
  assert.deepEqual(savedDeviceStatus({ ...base, enumerationStatus: "ready", permission: "unknown" }), {
    missing: true,
    unavailable: false,
    label: "Saved microphone (not currently listed)",
  });
  assert.deepEqual(savedDeviceStatus({ ...base, enumerationStatus: "ready", permission: "granted" }), {
    missing: true,
    unavailable: true,
    label: "Saved microphone (unavailable)",
  });
});

test("an enumerated saved device remains available", () => {
  assert.deepEqual(savedDeviceStatus({
    kind: "speaker",
    selectedId: "saved",
    devices: [{ deviceId: "saved" }],
    enumerationStatus: "ready",
    permission: "granted",
  }), { missing: false, unavailable: false, label: "" });
});
