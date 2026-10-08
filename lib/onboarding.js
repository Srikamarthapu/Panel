import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDirectory, readJson, writeJson } from "./work-store.js";
import { ONBOARDING_OUTCOMES, ONBOARDING_VERSION, normalizeOnboardingDecision } from "./onboarding-state.js";

export { ONBOARDING_REPLAY_EVENT, ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION, normalizeOnboardingDecision, parseOnboardingDecision } from "./onboarding-state.js";

const nonEmptyDirectory = (directory, predicate = () => true) => {
  try { return fs.readdirSync(directory, { withFileTypes: true }).some(entry => predicate(entry)); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
const localFileExists = file => {
  try { return fs.statSync(/*turbopackIgnore: true*/ file).isFile(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

export function existingPanelEvidence({ directory = dataDirectory() } = {}) {
  const evidence = [];
  if (nonEmptyDirectory(path.join(directory, "work-sessions"), entry => entry.isFile() && entry.name.endsWith(".json"))) evidence.push("saved-sessions");
  if (nonEmptyDirectory(path.join(directory, "agents"), entry => entry.isDirectory())) evidence.push("saved-agents");
  if (localFileExists(path.join(directory, "voice-config.json"))) evidence.push("voice-settings");
  if (localFileExists(path.join(directory, "voice-activity.json"))) evidence.push("voice-history");
  if (localFileExists(path.join(directory, "mission-control.json"))) evidence.push("workspace-state");
  return evidence;
}

export function onboardingState({ directory = dataDirectory() } = {}) {
  const decision = normalizeOnboardingDecision(readJson(path.join(directory, "onboarding.json")));
  const evidence = existingPanelEvidence({ directory });
  return {
    version: ONBOARDING_VERSION,
    needsOnboarding: !decision && evidence.length === 0,
    decision,
    existingEvidence: evidence,
  };
}

export function saveOnboardingDecision(outcome, { directory = dataDirectory(), now = () => new Date().toISOString() } = {}) {
  if (!ONBOARDING_OUTCOMES.has(outcome)) throw new Error("Choose a valid onboarding outcome.");
  const decision = { version: ONBOARDING_VERSION, outcome, updatedAt: now() };
  writeJson(path.join(directory, "onboarding.json"), decision);
  return decision;
}

export function onboardingEnvironment({ directory = dataDirectory(), hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes") } = {}) {
  const executableCandidates = [
    path.join(hermesHome, "hermes-agent", ".hermes", "bin", "hermes"),
    path.join(hermesHome, "hermes-agent", "venv", "bin", "hermes"),
    path.join(hermesHome, "bin", "hermes"),
  ];
  const installed = executableCandidates.some(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
  const configured = ["config.yaml", "auth.json"].some(file => {
    try { return fs.statSync(path.join(hermesHome, file)).isFile(); } catch { return false; }
  });
  return {
    hermes: { installed, configured },
    storage: { panelData: path.resolve(/*turbopackIgnore: true*/ directory), hermesHome: path.resolve(/*turbopackIgnore: true*/ hermesHome) },
  };
}
