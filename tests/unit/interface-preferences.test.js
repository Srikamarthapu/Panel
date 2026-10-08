import test from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_PALETTES,
  DEFAULT_INTERFACE_PREFERENCES,
  getEffectiveReducedMotion,
  normalizeInterfacePreferences,
  parseInterfacePreferences,
} from "../../lib/interface-preferences.js";

test("local appearance storage accepts only recognized bounded preferences", () => {
  const expected = { version: 1, motion: "full", pointerFollowing: false, companionGlow: false, companionFloat: false, avatarColor: "blue", textSize: "larger", conversationSpacing: "compact" };
  assert.deepEqual(parseInterfacePreferences(JSON.stringify({ ...expected, apiKey: "never retain" })), expected);
  assert.deepEqual(normalizeInterfacePreferences({ motion: "run-code", pointerFollowing: "false", avatarColor: "url(secret)", textSize: 400 }), DEFAULT_INTERFACE_PREFERENCES);
  for (const bad of [null, "{", "null", "[]", '"string"', '{"version":99,"textSize":"larger"}', "x".repeat(4097)]) {
    assert.deepEqual(parseInterfacePreferences(bad), DEFAULT_INTERFACE_PREFERENCES);
  }
});

test("system motion follows accessibility and an explicit choice takes effect", () => {
  assert.equal(getEffectiveReducedMotion({ motion: "system" }, true), true);
  assert.equal(getEffectiveReducedMotion({ motion: "system" }, false), false);
  assert.equal(getEffectiveReducedMotion({ motion: "full" }, true), false);
  assert.equal(getEffectiveReducedMotion({ motion: "reduced" }, false), true);
  assert.equal(getEffectiveReducedMotion({ motion: "broken" }, true), true);
});

test("each curated avatar palette has a safe usable color", () => {
  assert.equal(Object.keys(AVATAR_PALETTES).length, 4);
  for (const palette of Object.values(AVATAR_PALETTES)) {
    assert.match(palette.color, /^#[0-9a-f]{6}$/);
    assert.ok(palette.hue >= 0 && palette.hue <= 360);
    assert.ok(palette.saturation >= 0 && palette.saturation <= 100);
  }
});
