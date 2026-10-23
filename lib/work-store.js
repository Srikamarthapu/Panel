import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const dataDirectory = () => path.resolve(process.env.PANEL_DATA_DIR || path.join(process.cwd(), "data"));
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temp, file);
  // Persist the rename as well as the contents before an execution is allowed.
  if (process.platform !== "win32") {
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  if (process.platform === "win32") return processAlive(pid);
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function commandText(command, args) {
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim(); }
  catch { return ""; }
}
let cachedBootIdentity;
let cachedSelfIdentity;
function bootIdentity() {
  if (cachedBootIdentity !== undefined) return cachedBootIdentity;
  if (process.platform === "linux") {
    try { cachedBootIdentity = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
    catch { cachedBootIdentity = ""; }
  } else if (process.platform === "darwin") cachedBootIdentity = commandText("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
  else cachedBootIdentity = "";
  return cachedBootIdentity;
}
/** A durable PID is owned only while its boot-bound process start token still
 * matches. Liveness alone is insufficient because operating systems reuse PIDs. */
export function processIdentity(pid) {
  if (pid === process.pid && cachedSelfIdentity) return cachedSelfIdentity;
  if (!processAlive(pid)) return null;
  let identity = null;
  if (process.platform === "linux") {
    try {
      const boot = bootIdentity();
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      const started = fields[19]; // proc(5) field 22; fields[0] is state (field 3).
      identity = boot && started ? `linux:${boot}:${started}` : null;
    } catch { return null; }
  } else if (process.platform === "darwin") {
    const boot = bootIdentity();
    const started = commandText("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
    identity = boot && started ? `darwin:${boot}:${started}` : null;
  } else if (process.platform === "win32") {
    const started = commandText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]);
    identity = started ? `win32:${started}` : null;
  } else {
    const started = commandText("ps", ["-p", String(pid), "-o", "lstart="]);
    identity = started ? `${process.platform}:${started}` : null;
  }
  if (pid === process.pid && identity) cachedSelfIdentity = identity;
  return identity;
}
export function processMatchesIdentity(pid, identity) {
  return typeof identity === "string" && identity.length > 0 && processIdentity(pid) === identity;
}
export function processGroupMatchesIdentity(pid, identity) {
  return processMatchesIdentity(pid, identity) && processGroupAlive(pid);
}
// Locks protect only synchronous disk transactions, never a running task.
export function withFileLock(file, callback, probes = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  const ownerProcessAlive = typeof probes.processAlive === "function" ? probes.processAlive : processAlive;
  const ownerProcessIdentity = typeof probes.processIdentity === "function" ? probes.processIdentity : processIdentity;
  const pidIdentity = processIdentity(process.pid);
  if (!pidIdentity) throw new Error("Panel could not verify ownership of a saved-state lock. Restart Panel and try again.");
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, pidIdentity })); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = readJson(lock);
        const ownerPid = Number.isInteger(owner?.pid) && owner.pid >= 2 ? owner.pid : null;
        if (ownerPid && !ownerProcessAlive(ownerPid)) { fs.unlinkSync(lock); continue; }
        if (ownerPid) {
          const expected = typeof owner.pidIdentity === "string" && owner.pidIdentity ? owner.pidIdentity : null;
          const observed = ownerProcessIdentity(ownerPid);
          // A transient identity lookup failure is not evidence that a live
          // process lost its lock. Recover only from a proven PID reuse.
          if (expected && observed && observed !== expected) { fs.unlinkSync(lock); continue; }
        }
        if (!owner?.pid && Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.unlinkSync(lock); continue; }
      } catch {
        // A crash between exclusive creation and writing the PID can leave an
        // empty lock. Only recover after far more than a transaction can take.
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock); } catch {}
      }
      if (Date.now() >= deadline) { const busy = new Error("Saved work is busy. Try again in a moment."); busy.status = 409; throw busy; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return callback(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function inputError(message, status = 400) { const error = new Error(message); error.status = status; return error; }
