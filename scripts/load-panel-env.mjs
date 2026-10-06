import nextEnv from "@next/env";
import { fileURLToPath } from "node:url";
export const panelRoot = fileURLToPath(new URL("../", import.meta.url));
export function loadPanelEnvironment(development = process.env.NODE_ENV !== "production") {
  // Load before importing disk stores so the worker and Next resolve the same
  // PANEL_DATA_DIR and provider environment. Explicit process env wins.
  nextEnv.loadEnvConfig(panelRoot, development, { info() {}, error: console.error });
}
