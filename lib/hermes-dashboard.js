import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:9119/models?profile=default";
export const PROVIDER_SETUP_URL = "https://hermes-agent.nousresearch.com/docs/integrations/providers/";

export function dashboardModelsUrl(value = process.env.PANEL_HERMES_DASHBOARD_URL) {
  const url = new URL(value || DEFAULT_DASHBOARD_URL);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || [...url.searchParams.keys()].some(key => key !== "profile") || url.hash) {
    throw new Error("PANEL_HERMES_DASHBOARD_URL must be a local dashboard URL with only an optional profile query.");
  }
  return url.href;
}

export function hermesProviderSetup() {
  return { dashboardUrl: dashboardModelsUrl(), command: "hermes model", dashboardCommand: "hermes dashboard", docsUrl: PROVIDER_SETUP_URL };
}

export async function openHermesDashboard({ platform = process.platform, run = execute, url = dashboardModelsUrl() } = {}) {
  if (platform !== "darwin") throw Object.assign(new Error("Open the dashboard link in your browser."), { status: 400 });
  const target = dashboardModelsUrl(url);
  try {
    // Fixed, locally configured loopback URL. Never accept a URL or command
    // from the request body, and never pass credentials to a process.
    await run("/usr/bin/open", [target], { timeout: 5000, maxBuffer: 8192 });
  } catch {
    throw Object.assign(new Error("The dashboard could not be opened. Copy its address into your browser."), { status: 503 });
  }
  return { opened: true };
}
