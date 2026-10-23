import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

const root = process.cwd();
const serverScript = path.join(root, "scripts/test-browser-server.mjs");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function eventually(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

function fakeNext(directory) {
  const executable = path.join(directory, "fake-next.mjs");
  fs.writeFileSync(executable, `import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
const fixture = path.dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];
fs.appendFileSync(path.join(fixture, "phases.log"), command + "\\n");
if (command === "build") {
  if (fs.existsSync(path.join(fixture, "hold-build"))) setInterval(() => {}, 1000);
} else if (command === "start") {
  const args = process.argv.slice(3);
  const port = Number(args[args.indexOf("-p") + 1]);
  const server = http.createServer((request, response) => { response.end("ready"); });
  server.listen(port, "127.0.0.1");
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else process.exitCode = 2;
`);
  return executable;
}

function launchFixture(t, { holdBuild = false, port } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "panel-browser-lifecycle-"));
  if (holdBuild) fs.writeFileSync(path.join(fixture, "hold-build"), "1");
  const executable = fakeNext(fixture);
  let output = "";
  const wrapper = spawn(process.execPath, [serverScript], {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, TMPDIR: fixture, PANEL_TEST_NEXT_BINARY: executable, PANEL_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = chunk => { output = `${output}${chunk}`.slice(-20_000); };
  wrapper.stdout.on("data", append);
  wrapper.stderr.on("data", append);
  t.after(() => {
    if (wrapper.exitCode === null && wrapper.signalCode === null) {
      try { process.kill(process.platform === "win32" ? wrapper.pid : -wrapper.pid, "SIGKILL"); } catch {}
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  return { fixture, wrapper, output: () => output };
}

async function waitForPhase(run, phase) {
  const marker = path.join(run.fixture, "phases.log");
  await eventually(() => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").split("\n").includes(phase), `Browser wrapper did not reach ${phase}.\n${run.output()}`);
}

async function waitForExit(wrapper) {
  if (wrapper.exitCode === null && wrapper.signalCode === null) await once(wrapper, "exit");
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`browser wrapper releases its listening fixture after ${signal}`, async t => {
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    const run = launchFixture(t, { port });
    await waitForPhase(run, "start");
    await eventually(() => responds(url), `Fixture did not listen on ${port}.\n${run.output()}`);
    process.kill(run.wrapper.pid, signal);
    await waitForExit(run.wrapper);
    await eventually(async () => !(await responds(url)), `Fixture still owned ${port} after ${signal}.`);
  });
}

test("browser wrapper stops during build without starting the server", async t => {
  const run = launchFixture(t, { holdBuild: true, port: await availablePort() });
  await waitForPhase(run, "build");
  process.kill(run.wrapper.pid, "SIGTERM");
  await waitForExit(run.wrapper);
  assert.doesNotMatch(fs.readFileSync(path.join(run.fixture, "phases.log"), "utf8"), /^start$/m);
});

test("Playwright-style process-group SIGKILL does not strand the listening fixture", async t => {
  if (process.platform === "win32") return t.skip("Process-group ownership is POSIX-specific.");
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const run = launchFixture(t, { port });
  await waitForPhase(run, "start");
  await eventually(() => responds(url), `Fixture did not listen on ${port}.\n${run.output()}`);
  process.kill(-run.wrapper.pid, "SIGKILL");
  await waitForExit(run.wrapper);
  await eventually(async () => !(await responds(url)), `Fixture still owned ${port} after process-group SIGKILL.`);
});

for (const [name, cwd, port] of [["invalid port", root, "1"], ["staging failure", null, "34567"]]) {
  test(`${name} leaves no temporary browser stage`, async t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-browser-failure-"));
    const source = cwd || path.join(temporary, "empty-source");
    fs.mkdirSync(source, { recursive: true });
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const child = spawn(process.execPath, [serverScript], {
      cwd: source,
      env: { ...process.env, TMPDIR: temporary, PANEL_TEST_PORT: port },
      stdio: "ignore",
    });
    await once(child, "exit");
    assert.notEqual(child.exitCode, 0);
    assert.deepEqual(fs.readdirSync(temporary).filter(entry => entry.startsWith("panel-browser-")), []);
  });
}
