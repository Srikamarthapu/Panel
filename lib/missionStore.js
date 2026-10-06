import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const storeDir = path.join(process.cwd(), "data");
const storePath = path.join(storeDir, "mission-control.json");

const defaultStore = {
  projects: []
};

function ensureStore() {
  if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
  if (!fs.existsSync(storePath)) fs.writeFileSync(storePath, JSON.stringify(defaultStore, null, 2));
}

export function readMissionStore() {
  try {
    ensureStore();
    return { ...defaultStore, ...JSON.parse(fs.readFileSync(storePath, "utf8")) };
  } catch {
    return defaultStore;
  }
}

export function writeMissionStore(nextStore) {
  ensureStore();
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...defaultStore, ...nextStore }, null, 2));
  fs.renameSync(tmp, storePath);
}

export function addProject(input) {
  const store = readMissionStore();
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    summary: input.summary.trim(),
    status: input.status?.trim() || "active",
    owner: input.owner?.trim() || "Hermes",
    createdAt: now,
    updatedAt: now
  };
  writeMissionStore({ ...store, projects: [project, ...(store.projects || [])] });
  return project;
}

export { storePath };
