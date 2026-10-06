#!/usr/bin/env node
import { loadPanelEnvironment } from "./load-panel-env.mjs";
loadPanelEnvironment();
const { acquireQueueWorker, heartbeatQueueWorker, releaseQueueWorker, tickWorkQueue } = await import("../lib/work-queue.js");
const { processAlive } = await import("../lib/work-store.js");

const lease = acquireQueueWorker();
if (!lease) { console.log("Panel queue: another worker already owns this data directory."); process.exit(0); }
const parentPid = Number(process.env.PANEL_PARENT_PID);
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopped = true; });
const heartbeat = setInterval(() => {
  try { if (!heartbeatQueueWorker(lease)) stopped = true; }
  catch (error) { console.error(`Panel queue heartbeat: ${error.message}`); stopped = true; }
}, 2000);
console.log("Panel queue: running. Scheduled work requires Panel and this computer to stay on.");
try {
  while (!stopped) {
    if (parentPid && !processAlive(parentPid)) break;
    if (!heartbeatQueueWorker(lease)) break;
    try { await tickWorkQueue(); }
    catch (error) { console.error(`Panel queue: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { clearInterval(heartbeat); releaseQueueWorker(lease); }
