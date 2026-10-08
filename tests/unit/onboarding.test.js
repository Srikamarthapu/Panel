import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { existingPanelEvidence, onboardingEnvironment, onboardingState, parseOnboardingDecision, saveOnboardingDecision } from "../../lib/onboarding.js";
import { onboardingReadinessResults } from "../../lib/onboarding-state.js";

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "panel-onboarding-"));

test("fresh profiles require onboarding and skip or completion persist", () => {
  const directory = fixture();
  try {
    assert.equal(onboardingState({ directory }).needsOnboarding, true);
    const skipped = saveOnboardingDecision("skipped", { directory, now: () => "2026-10-07T00:00:00.000Z" });
    assert.deepEqual(onboardingState({ directory }).decision, skipped);
    assert.equal(onboardingState({ directory }).needsOnboarding, false);
    assert.throws(() => saveOnboardingDecision("secret-value", { directory }), /valid onboarding outcome/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const completedDirectory = fixture();
  try {
    const completed = saveOnboardingDecision("completed", { directory: completedDirectory, now: () => "2026-10-07T01:00:00.000Z" });
    assert.equal(completed.outcome, "completed");
    assert.equal(onboardingState({ directory: completedDirectory }).needsOnboarding, false);
  } finally { fs.rmSync(completedDirectory, { recursive: true, force: true }); }
});

test("provider check failures stay explicit while an independent voice check remains usable", () => {
  const result = onboardingReadinessResults(
    { status: "rejected", reason: new Error("Hermes catalog is offline") },
    { status: "fulfilled", value: { readiness: "configured" } },
  );
  assert.equal(result.models, null);
  assert.equal(result.errors.models, "Hermes catalog is offline");
  assert.deepEqual(result.voice, { readiness: "configured" });
  assert.equal(result.errors.voice, "");
});

test("saved user artifacts identify an existing profile without inspecting secrets", () => {
  const directory = fixture();
  try {
    fs.mkdirSync(path.join(directory, "work-sessions"));
    fs.writeFileSync(path.join(directory, "work-sessions", "saved.json"), "{}");
    fs.writeFileSync(path.join(directory, "voice-config.json"), "{not parsed by detection}");
    assert.deepEqual(existingPanelEvidence({ directory }), ["saved-sessions", "voice-settings"]);
    assert.equal(onboardingState({ directory }).needsOnboarding, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("stored client decisions reject malformed or extra outcomes", () => {
  assert.equal(parseOnboardingDecision("{"), null);
  assert.equal(parseOnboardingDecision(JSON.stringify({ version: 1, outcome: "completed", updatedAt: "now", providerKey: "ignored" })).outcome, "completed");
  assert.equal(parseOnboardingDecision(JSON.stringify({ version: 1, outcome: "later" })), null);
});

test("environment reports concrete local paths and readiness without provider values", () => {
  const root = fixture(), directory = path.join(root, "panel"), hermesHome = path.join(root, ".hermes");
  try {
    fs.mkdirSync(path.join(hermesHome, "hermes-agent", ".hermes", "bin"), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, "hermes-agent", ".hermes", "bin", "hermes"), "#!/bin/sh\n", { mode: 0o700 });
    fs.writeFileSync(path.join(hermesHome, "config.yaml"), "provider: private\n", { mode: 0o600 });
    const result = onboardingEnvironment({ directory, hermesHome });
    assert.deepEqual(result.hermes, { installed: true, configured: true });
    assert.equal(result.storage.panelData, directory);
    assert.equal(result.storage.hermesHome, hermesHome);
    assert.equal(JSON.stringify(result).includes("private"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
