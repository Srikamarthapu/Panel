import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserBuildArguments, browserServerEnvironment, browserStartArguments, stageBrowserProject } from "../../scripts/test-browser-environment.mjs";

test("browser server stages source without env files and uses empty private roots", t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "panel-browser-env-test-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, "checkout");
  const temporary = path.join(fixture, "runtime");
  for (const directory of ["app/dev/fixture", "components", "lib", "public", "runtime", "scripts", "node_modules"]) fs.mkdirSync(path.join(source, directory), { recursive: true });
  for (const file of ["jsconfig.json", "next.config.mjs", "package.json", "package-lock.json", "proxy.js"]) fs.writeFileSync(path.join(source, file), "{}\n");
  fs.writeFileSync(path.join(source, "app/dev/fixture/page.jsx"), "export default function Fixture() {}\n");
  fs.writeFileSync(path.join(source, ".env"), "OPENAI_API_KEY=private\n");
  fs.writeFileSync(path.join(source, "app/.env.local"), "DEEPSEEK_API_KEY=private\n");

  const stage = stageBrowserProject(source, temporary);
  assert.ok(fs.existsSync(path.join(stage, "app/dev/fixture/page.jsx")));
  assert.equal(fs.existsSync(path.join(stage, ".env")), false);
  assert.equal(fs.existsSync(path.join(stage, "app/.env.local")), false);
  assert.equal(fs.lstatSync(path.join(stage, "node_modules")).isSymbolicLink(), true);

  const environment = browserServerEnvironment(temporary, {
    PATH: "/bin",
    OPENAI_API_KEY: "private",
    ELEVENLABS_API_KEY: "private",
  });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.ELEVENLABS_API_KEY, undefined);
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.HERMES_VOICE_FIXTURE, "1");
  assert.equal(fs.readdirSync(environment.HERMES_REPO).length, 0);
  assert.equal(fs.readdirSync(environment.HERMES_HOME).length, 0);
  assert.ok(environment.PANEL_DATA_DIR.startsWith(temporary));
  assert.deepEqual(browserBuildArguments("/next"), ["/next", "build", "--webpack"]);
  assert.deepEqual(browserStartArguments("/next", 3456), ["/next", "start", "-H", "127.0.0.1", "-p", "3456"]);
});
