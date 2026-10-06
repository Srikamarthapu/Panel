import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
// Locks protect only synchronous disk transactions, never a running task.
export function withFileLock(file, callback) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = readJson(lock);
        if (owner?.pid && !processAlive(owner.pid)) { fs.unlinkSync(lock); continue; }
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
