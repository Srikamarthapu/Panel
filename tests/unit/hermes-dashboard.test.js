import test from "node:test";
import assert from "node:assert/strict";
import { dashboardModelsUrl, DEFAULT_DASHBOARD_URL, openHermesDashboard } from "../../lib/hermes-dashboard.js";

test("dashboard links stay local and never carry credentials", () => {
  assert.equal(dashboardModelsUrl(""), DEFAULT_DASHBOARD_URL);
  assert.equal(dashboardModelsUrl("http://localhost:9120/models?profile=research"), "http://localhost:9120/models?profile=research");
  for (const url of ["https://evil.example/models", "http://localhost.evil.example/models", "file:///tmp/dashboard", "javascript:alert(1)", "http://me:secret@localhost:9119/models", "http://127.0.0.1:9119/models?token=secret", "http://127.0.0.1:9119/models#secret"]) assert.throws(() => dashboardModelsUrl(url));
});

test("native dashboard opening passes one validated URL as an argument without a shell", async () => {
  let called;
  assert.deepEqual(await openHermesDashboard({ platform: "darwin", url: DEFAULT_DASHBOARD_URL, run: async (...args) => { called = args; } }), { opened: true });
  assert.deepEqual(called.slice(0, 2), ["/usr/bin/open", [DEFAULT_DASHBOARD_URL]]);
  assert.equal(called[2].timeout, 5000);
  assert.equal(called[2].shell, undefined);
  await assert.rejects(openHermesDashboard({ platform: "darwin", url: "https://remote.example", run: () => assert.fail("must not launch") }));
  await assert.rejects(openHermesDashboard({ platform: "linux", run: () => assert.fail("must not launch") }), /browser/);
});

test("launch failures return helpful text without raw process output", async () => {
  await assert.rejects(openHermesDashboard({ platform: "darwin", run: async () => { throw new Error("private stderr"); } }), error => error.status === 503 && !error.message.includes("private stderr"));
});
