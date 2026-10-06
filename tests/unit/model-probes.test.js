import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { modelCredentialRevision, modelProbeKey, readModelProbeEvidence, runConnectionProbe, saveModelProbeEvidence, sanitizeModelProbe } from "../../lib/model-probes.js";

const connection = { provider: "remote", model: "exact-model", apiKey: "private-key-never-expose", baseUrl: "https://configured.invalid/v1", protocol: "chat_completions" };

test("model tests use only the configured connection and require a real response payload", async () => {
  let called = 0;
  const result = await runConnectionProbe(connection, { fetchImpl: async (url, options) => {
    called += 1;
    assert.equal(url, "https://configured.invalid/v1/chat/completions");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${connection.apiKey}`);
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, "exact-model");
    assert.equal(payload.max_tokens, 64);
    assert.deepEqual(payload.messages, [{ role: "user", content: "Reply with OK." }]);
    return Response.json({ choices: [{ message: { content: "OK" } }], secretField: connection.apiKey });
  } });
  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, "available");
  assert.equal(JSON.stringify(result).includes(connection.apiKey), false);
  const empty = await runConnectionProbe(connection, { fetchImpl: async () => Response.json({ choices: [] }) });
  assert.equal(empty.ok, false, "HTTP 200 without generated content does not prove model access");
});

test("Anthropic tests follow its provider protocol", async () => {
  const result = await runConnectionProbe({ ...connection, protocol: "anthropic_messages" }, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://configured.invalid/v1/messages");
    assert.equal(options.headers["x-api-key"], connection.apiKey);
    assert.equal(options.headers["anthropic-version"], "2023-06-01");
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ content: [{ type: "text", text: "OK" }] });
  } });
  assert.equal(result.ok, true);
});

test("OpenAI reasoning chat probes keep a bounded completion cap and require generated reasoning evidence", async () => {
  const body = { id: "chat-fixture", object: "chat.completion", choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { completion_tokens: 64, completion_tokens_details: { reasoning_tokens: 64 } } };
  const reasoningConnection = { ...connection, model: "o3", tokenLimitParameter: "max_completion_tokens" };
  const result = await runConnectionProbe(reasoningConnection, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.max_completion_tokens, 64);
    assert.equal(payload.max_tokens, undefined);
    return Response.json(body);
  } });
  assert.equal(result.ok, true);
  for (const invalid of [{ ...body, choices: [] }, { ...body, object: "unknown" }, { ...body, usage: { completion_tokens: 64 } }, { ...body, usage: { completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } } }]) {
    assert.equal((await runConnectionProbe(reasoningConnection, { fetchImpl: async () => Response.json(invalid) })).ok, false);
  }
  await runConnectionProbe({ ...reasoningConnection, protocol: "anthropic_messages" }, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.max_tokens, 64);
    assert.equal(payload.max_completion_tokens, undefined);
    return Response.json({ content: [{ type: "text", text: "OK" }] });
  } });
});

test("OpenAI Responses tests use its response API and preserve private configured headers", async () => {
  const result = await runConnectionProbe({ ...connection, protocol: "codex_responses", extraHeaders: { "x-private-header": connection.apiKey } }, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://configured.invalid/v1/responses");
    assert.equal(options.headers["x-private-header"], connection.apiKey);
    assert.deepEqual(JSON.parse(options.body), { model: "exact-model", input: "Reply with OK.", max_output_tokens: 64 });
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] });
  } });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(connection.apiKey), false);
});

test("Responses reasoning generation proves access without mistaking an empty HTTP200 for inference", async () => {
  const body = { id: "response-fixture", object: "response", status: "incomplete", output: [{ id: "reasoning-fixture", type: "reasoning", summary: [] }], usage: { output_tokens: 64, output_tokens_details: { reasoning_tokens: 64 } } };
  const responsesConnection = { ...connection, protocol: "codex_responses" };
  assert.equal((await runConnectionProbe(responsesConnection, { fetchImpl: async () => Response.json(body) })).ok, true);
  for (const invalid of [{ ...body, output: [] }, { ...body, status: "failed" }, { ...body, usage: { output_tokens: 64 } }, { ...body, object: "unknown" }]) {
    assert.equal((await runConnectionProbe(responsesConnection, { fetchImpl: async () => Response.json(invalid) })).ok, false);
  }
});

test("tests report bounded safe errors and distinguish timeout from rejected access", async () => {
  for (const [http, status] of [[401, "auth_error"], [403, "auth_error"], [404, "not_found"], [429, "rate_limited"], [500, "error"]]) {
    const result = await runConnectionProbe(connection, { fetchImpl: async () => new Response(connection.apiKey, { status: http }) });
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result).includes(connection.apiKey), false);
  }
  const timeout = await runConnectionProbe(connection, { timeoutMs: 1, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error(connection.apiKey)), { once: true }); }) });
  assert.equal(timeout.status, "timeout");
  const failure = await runConnectionProbe(connection, { fetchImpl: async () => { throw new Error(connection.apiKey); } });
  assert.equal(failure.status, "error");
  assert.equal(JSON.stringify(failure).includes(connection.apiKey), false);
  const oversized = await runConnectionProbe(connection, { fetchImpl: async () => new Response("x".repeat(65 * 1024)) });
  assert.equal(oversized.status, "error");
});

test("cancellation racing a completed provider response cannot report a successful probe", async () => {
  const controller = new AbortController();
  const result = await runConnectionProbe(connection, { signal: controller.signal, fetchImpl: async () => {
    const response = Response.json({ choices: [{ message: { content: "OK" } }] });
    controller.abort();
    return response;
  } });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
});

test("cancellation during the post-probe catalog read cannot persist successful evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-cancelled-probe-"));
  const home = path.join(directory, "home");
  const repo = path.join(directory, "runtime");
  const data = path.join(directory, "data");
  const catalogModule = pathToFileURL(path.resolve("lib/model-catalog.js")).href;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(repo, "venv", "bin"), { recursive: true });
    fs.mkdirSync(path.join(directory, "scripts", "models"), { recursive: true });
    const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    fs.symlinkSync(python, path.join(repo, "venv", "bin", "python"));
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    fs.writeFileSync(path.join(directory, "scripts", "models", "hermes-catalog.py"), `import json, pathlib, sys, time
root = pathlib.Path.cwd()
request = json.loads(sys.stdin.read())
revision = "a" * 64
if request["action"] == "resolve_probe":
    print(json.dumps({"ok": True, "provider": "fixture", "model": "fixture-model", "baseUrl": "https://fixture.invalid/v1", "apiKey": "fixture-key", "protocol": "chat_completions", "credentialRevision": revision}))
else:
    if (root / "wait-next-catalog").exists():
        (root / "catalog-awaiting").write_text("ready")
        deadline = time.monotonic() + 4
        while not (root / "release-catalog").exists():
            assert time.monotonic() < deadline
            time.sleep(0.005)
    print(json.dumps({"ok": True, "current": {"provider": "fixture", "model": "fixture-model"}, "providers": [{"id": "fixture", "configured": True, "supportsProbe": True, "supportsCustomModel": True, "models": [{"id": "fixture-model"}]}], "providerCredentialRevisions": {"fixture": revision}}))
`);
    const program = `
import fs from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
const { probeModelSelection } = await import(${JSON.stringify(catalogModule)});
const controller = new AbortController();
globalThis.fetch = async () => {
  fs.writeFileSync("wait-next-catalog", "ready");
  fs.writeFileSync(process.env.HERMES_HOME + "/auth.json", JSON.stringify({updated_at:"after-network-response"}));
  return Response.json({ choices: [{ message: { content: "OK" } }] });
};
const pending = probeModelSelection({provider:"fixture",model:"fixture-model"}, {signal:controller.signal});
const deadline = Date.now() + 3000;
while (!fs.existsSync("catalog-awaiting")) { assert.ok(Date.now() < deadline, "post-probe catalog should be awaiting"); await pause(5); }
controller.abort();
fs.writeFileSync("release-catalog", "ready");
await pending;
assert.equal(fs.existsSync(process.env.PANEL_DATA_DIR + "/model-probes.json"), false, "cancelled request must not persist its earlier success");
process.stdout.write(JSON.stringify({cancelledAfterNetwork:true,evidenceSaved:false}));
`;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: directory, env: { ...process.env, HERMES_HOME: home, HERMES_REPO: repo, PANEL_DATA_DIR: data }, encoding: "utf8", timeout: 8000 });
    assert.deepEqual(JSON.parse(output), { cancelledAfterNetwork: true, evidenceSaved: false });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("saved test evidence distinguishes providers, expires, and is invalidated by credential changes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-model-probes-"));
  const checkedAt = new Date().toISOString();
  try {
    const record = { provider: "first", model: "same", status: "available", ok: true, checkedAt, latencyMs: 4, detail: connection.apiKey, apiKey: connection.apiKey, rawBody: connection.apiKey };
    saveModelProbeEvidence(record, { directory, credentialRevision: "account-a" });
    saveModelProbeEvidence({ ...record, provider: "second", status: "not_found", ok: false }, { directory, credentialRevision: "account-a" });
    const evidence = readModelProbeEvidence({ directory, credentialRevision: "account-a" });
    assert.equal(evidence[modelProbeKey("first", "same")].ok, true);
    assert.equal(evidence[modelProbeKey("second", "same")].ok, false);
    assert.equal(Object.keys(readModelProbeEvidence({ directory, credentialRevision: "account-b" })).length, 0);
    assert.equal(Object.keys(readModelProbeEvidence({ directory, credentialRevision: "account-a", now: Date.now() + 31 * 86400000 })).length, 0);
    assert.equal(fs.readFileSync(path.join(directory, "model-probes.json"), "utf8").includes(connection.apiKey), false);
    assert.equal(fs.statSync(path.join(directory, "model-probes.json")).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(directory, "model-probes.json"), "invalid json");
    assert.deepEqual(readModelProbeEvidence({ directory, credentialRevision: "account-a" }), {});
    fs.writeFileSync(path.join(directory, "model-probes.json"), JSON.stringify({ records: [null, 5, {}] }));
    assert.deepEqual(readModelProbeEvidence({ directory, credentialRevisions: { first: "account-a" } }), {});
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("untrusted saved test fields never become browser evidence", () => {
  assert.equal(sanitizeModelProbe({ provider: "../secret", model: "x", status: "available", checkedAt: new Date().toISOString() }), null);
  assert.equal(sanitizeModelProbe({ provider: "safe", model: "x", status: "invented", checkedAt: new Date().toISOString() }), null);
});

test("provider evidence is invalidated independently rather than by another provider's account", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-provider-evidence-"));
  try {
    const record = { provider: "first", model: "same", status: "available", ok: true, checkedAt: new Date().toISOString(), latencyMs: 4 };
    saveModelProbeEvidence(record, { directory, credentialRevision: "first-key-a" });
    saveModelProbeEvidence({ ...record, provider: "second" }, { directory, credentialRevision: "second-key-a" });
    const evidence = readModelProbeEvidence({ directory, credentialRevisions: { first: "first-key-a", second: "second-key-b" } });
    assert.equal(evidence[modelProbeKey("first", "same")].ok, true);
    assert.equal(evidence[modelProbeKey("second", "same")], undefined);
    const changed = readModelProbeEvidence({ directory, credentialRevisions: { first: "first-key-b", second: "second-key-a" } });
    assert.equal(changed[modelProbeKey("first", "same")], undefined);
    assert.equal(changed[modelProbeKey("second", "same")].ok, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("saved or launcher credential/account changes invalidate evidence without exposing their values", () => {
  const baseline = { sources: ["provider-config", "saved-key-a", "account-a"], environment: { PROVIDER_KEY: "launcher-key-a", ROUTE: "configured" } };
  const revision = modelCredentialRevision(baseline);
  assert.equal(revision.length, 64);
  assert.equal(revision.includes("key-a"), false);
  assert.equal(modelCredentialRevision({ ...baseline, environment: { ROUTE: "configured", PROVIDER_KEY: "launcher-key-a" } }), revision);
  for (const changed of [
    { ...baseline, sources: ["provider-config", "saved-key-b", "account-a"] },
    { ...baseline, sources: ["provider-config", "saved-key-a", "account-b"] },
    { ...baseline, sources: ["new-endpoint-config", "saved-key-a", "account-a"] },
    { ...baseline, environment: { ...baseline.environment, PROVIDER_KEY: "launcher-key-b" } },
  ]) assert.notEqual(modelCredentialRevision(changed), revision);
});

test("build, npm and process metadata preserve test evidence while custom referenced credentials do not", () => {
  const baseline = { sources: ["same-private-config"], environment: { PROVIDER_API_KEY: "same-key", HERMES_BUILD_ID: "build-a", HERMES_NEXT_DIST_DIR: ".next-a", NEXT_DIST_DIR: ".next-a", PORT: "3014", npm_lifecycle_event: "dev", npm_lifecycle_script: "next dev", PWD: "/same-source", INIT_CWD: "/same-source", NODE_ENV: "development" } };
  const revision = modelCredentialRevision(baseline);
  const restarted = { ...baseline, environment: { ...baseline.environment, HERMES_BUILD_ID: "build-b", HERMES_NEXT_DIST_DIR: ".next-b", NEXT_DIST_DIR: ".next-b", PORT: "3000", npm_lifecycle_event: "start", npm_lifecycle_script: "next start", PWD: "/another-source", INIT_CWD: "/another-source", NODE_ENV: "production" } };
  assert.equal(modelCredentialRevision(restarted), revision);
  assert.notEqual(modelCredentialRevision({ ...restarted, environment: { ...restarted.environment, PROVIDER_API_KEY: "new-key" } }), revision);
  const custom = { sources: ["config-references-wizard"], environment: { WIZARD: "account-a" }, referencedEnvironmentNames: ["WIZARD"] };
  assert.notEqual(modelCredentialRevision(custom), modelCredentialRevision({ ...custom, environment: { WIZARD: "account-b" } }));
  assert.notEqual(modelCredentialRevision(baseline), modelCredentialRevision({ ...baseline, environment: { ...baseline.environment, UNKNOWN_VENDOR_TOKEN: "new-account" } }));
});
