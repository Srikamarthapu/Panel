import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);

// Keep slow CLI startup off the server event loop so chat polling and Stop work
// while another tab creates a task or manages its gateway.
export async function runHermesCommand(args, { timeout = 15_000 } = {}) {
  const home = os.homedir();
  const hermesHome = process.env.HERMES_HOME || path.join(home, ".hermes");
  const repo = process.env.HERMES_REPO || path.join(hermesHome, "hermes-agent");
  try {
    const { stdout } = await execute(process.env.HERMES_CLI_PATH || "hermes", args, {
      encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: [path.join(home, ".local/bin"), path.join(repo, "venv/bin"), process.env.PATH || ""].join(path.delimiter) },
    });
    return stdout;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Hermes is not installed or cannot be found. Run npm run doctor in the Panel folder.");
    if (error.killed) throw new Error("Hermes did not finish in time. Check the operation in Hermes before retrying.");
    throw new Error("Hermes could not complete this operation. Check its local logs and configuration before retrying.");
  }
}
