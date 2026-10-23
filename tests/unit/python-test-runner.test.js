import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("installed-Hermes mode fails before starting the requested interpreter", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-host-test-guard-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "interpreter-started");
  const sentinel = path.join(directory, "python-sentinel");
  fs.writeFileSync(sentinel, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 91\n`, { mode: 0o700 });

  const result = spawnSync(process.execPath, ["scripts/test-python.mjs", "--host"], {
    cwd: process.cwd(),
    env: { ...process.env, PANEL_TEST_PYTHON: sentinel },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed-Hermes tests are disabled/);
  assert.equal(fs.existsSync(marker), false);
});
