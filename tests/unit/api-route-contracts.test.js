import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "panel-api-contracts-"));
process.env.PANEL_DATA_DIR = path.join(temporary, "data");
process.env.HERMES_HOME = path.join(temporary, "hermes-home");
process.env.HERMES_REPO = path.join(temporary, "hermes-repo");
for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "ELEVENLABS_API_KEY"]) delete process.env[key];
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
  const target = path.resolve(root, specifier.slice(2));
  const file = fs.existsSync(target) ? target : `${target}.js`;
  return nextResolve(pathToFileURL(file).href, context);
} });
const sessions = await import("../../lib/work-sessions.js");
const tabs = await import("../../lib/workspace-tabs.js");
const adoptRoute = await import("../../app/api/sessions/adopt/route.js");
const directRoute = await import("../../app/api/direct/config/route.js");
const runtimeRoute = await import("../../app/api/voice/runtime/route.js");
const stateRoute = await import("../../app/api/workspace-tabs/[id]/state/route.js");
const artifactRoute = await import("../../app/api/workspace-tabs/[id]/artifact/route.js");
hooks.deregister();

after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("saved-session adoption rejects malformed and oversized message collections without mutation", async () => {
  const malformed = await adoptRoute.POST(new Request("http://127.0.0.1/api/sessions/adopt", {
    method: "POST",
    body: "{",
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /could not be imported/i);

  const sessionId = "too-many-imported-messages";
  const bounded = await adoptRoute.POST(new Request("http://127.0.0.1/api/sessions/adopt", {
    method: "POST",
    body: JSON.stringify({ sessionId, messages: Array.from({ length: 101 }, () => ({ role: "user", text: "x" })) }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(bounded.status, 400);
  assert.equal(sessions.getWorkSession(sessionId), null);
});

test("direct settings handler never returns a saved provider key", async () => {
  const secret = "synthetic-redaction-value-without-provider-prefix";
  const saved = await directRoute.PUT(new Request("http://127.0.0.1/api/direct/config", {
    method: "PUT",
    body: JSON.stringify({ provider: "openai", model: "test-model", apiKey: secret }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(saved.status, 200);
  const savedText = await saved.text();
  assert.equal(savedText.includes(secret), false);
  assert.equal(JSON.parse(savedText).config.providers.find(item => item.id === "openai").configured, true);

  const read = await directRoute.GET();
  const readText = await read.text();
  assert.equal(read.status, 200);
  assert.equal(readText.includes(secret), false);
  assert.equal(Object.hasOwn(JSON.parse(readText).config, "credentials"), false);
});

test("permission handler rejects an unknown or stale request before any runtime warmup", async () => {
  const session = sessions.createWorkSession({ id: "permission-contract", name: "Permission contract" });
  const response = await runtimeRoute.POST(new Request("http://127.0.0.1/api/voice/runtime", {
    method: "POST",
    body: JSON.stringify({ sessionId: session.id, actionId: "missing-run", requestId: "missing-request", optionId: "allow" }),
    headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /no longer available/i);
});

test("workspace state and artifact handlers preserve bounds and response headers", async () => {
  const tab = tabs.createWorkspaceTab({ id: "route-contract-tab", title: "Route contract" });
  const params = Promise.resolve({ id: tab.id });
  const saved = await stateRoute.PUT(new Request(`http://127.0.0.1/api/workspace-tabs/${tab.id}/state`, {
    method: "PUT",
    body: JSON.stringify({ value: { note: "local only" } }),
  }), { params });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { saved: true });
  const read = await stateRoute.GET(new Request(`http://127.0.0.1/api/workspace-tabs/${tab.id}/state`), { params });
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.deepEqual(await read.json(), { value: { note: "local only" } });

  const oversized = await stateRoute.PUT(new Request(`http://127.0.0.1/api/workspace-tabs/${tab.id}/state`, {
    method: "PUT",
    body: "x".repeat(100_101),
  }), { params });
  assert.equal(oversized.status, 413);

  const version = "00000000-0000-4000-8000-000000000001";
  const spec = { title: "Review", description: "", blocks: [{ id: "intro", type: "text", title: "Overview", text: "Safe text" }] };
  fs.writeFileSync(path.join(tabs.workspaceTabPaths(tab.id).directory, `${version}.json`), JSON.stringify(spec), { flag: "wx", mode: 0o600 });
  tabs.updateWorkspaceTab(tab.id, { previewVersion: version, phase: "preview" });
  const artifact = await artifactRoute.GET(new Request(`http://127.0.0.1/api/workspace-tabs/${tab.id}/artifact?preview=true`), { params });
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("cache-control"), "no-store");
  assert.equal(artifact.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await artifact.json(), { spec, version });
});
