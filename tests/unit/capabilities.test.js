import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("inventory reads metadata without executing plugins or exposing configuration secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-inventory-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  try {
    put(path.join(home, "config.yaml"), "api_key: secret-fixture-value\nplugins:\n  enabled: [example]\n  disabled: [disabled-example]\n");
    put(path.join(home, "skills", "writing", "outline", "SKILL.md"), "---\nname: Outline\ndescription: Plan a document\n---\nPrivate instruction body must not leave the inventory.");
    put(path.join(home, "plugins", "example", "plugin.yaml"), "name: example\nversion: 1.0\ndescription: Example plugin\n");
    put(path.join(home, "plugins", "example", "__init__.py"), "raise RuntimeError('plugin code must never execute')\n");
    put(path.join(repo, "plugins", "disabled-example", "plugin.json"), JSON.stringify({ name: "disabled-example", description: "Disabled example" }));
    const python = process.env.PANEL_TEST_PYTHON || "python3";
    const result = spawnSync(python, ["scripts/runtime/inventory.py"], { encoding: "utf8", env: { ...process.env, HERMES_HOME: home, HERMES_REPO: repo } });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.equal(inventory.skills[0].name, "Outline");
    assert.equal(inventory.skills[0].category, "writing");
    assert.equal(inventory.plugins.find(row => row.name === "example").status, "Enabled in settings");
    assert.equal(inventory.plugins.find(row => row.name === "disabled-example").status, "Disabled in settings");
    assert.doesNotMatch(result.stdout, /secret-fixture-value|Private instruction body|raise RuntimeError/);
    assert.equal(inventory.runtime.configurationFound, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
