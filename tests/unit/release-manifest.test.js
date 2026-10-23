import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkedSourceStat, compareManifest, discoverReleaseFiles } from "../../scripts/release/source-manifest.mjs";

test("release discovery includes test/runtime dependencies and excludes private workspace paths", () => {
  const files = discoverReleaseFiles(process.cwd());
  for (const expected of [
    "requirements-test.txt",
    "scripts/test-python.mjs",
    "scripts/test-browser-server.mjs",
    "tests/unit/api-route-contracts.test.js",
    "public/voice-vad/silero_vad_v5.onnx",
  ]) assert.ok(files.includes(expected), expected);
  assert.equal(files.some(file => file.startsWith("artifacts/") || file.startsWith("graphify-out/") || file.startsWith("public/voice-fixtures/") || file.startsWith("app/dev/voice-live/") || file.startsWith("app/dev/voice-endpointing/") || file.includes(".env.local")), false);
});

test("release manifest comparison exposes added, removed, and changed paths", () => {
  const before = { files: [{ path: "same", sha256: "a", bytes: 1 }, { path: "changed", sha256: "a", bytes: 1 }, { path: "removed", sha256: "a", bytes: 1 }] };
  const after = { files: [{ path: "same", sha256: "a", bytes: 1 }, { path: "changed", sha256: "b", bytes: 1 }, { path: "added", sha256: "a", bytes: 1 }] };
  assert.deepEqual(compareManifest(before, after), { added: ["added"], removed: ["removed"], changed: ["changed"] });
});

test("release source validation refuses symlinks", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-release-manifest-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "target"), "safe");
  fs.symlinkSync(path.join(directory, "target"), path.join(directory, "link"));
  assert.throws(() => checkedSourceStat(directory, "link"), /Refusing symlink/);
});
