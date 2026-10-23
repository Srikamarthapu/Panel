import test from "node:test";
import assert from "node:assert/strict";
import { config, proxy } from "../../proxy.js";

function request(path, { host = "127.0.0.1:3000", headers = {}, origin = "http://127.0.0.1:3000" } = {}) {
  return new Request(`${origin}${path}`, { headers: { host, ...headers } });
}

test("proxy covers pages and accepts local top-level and RSC requests", () => {
  assert.equal(config.matcher, "/:path*");
  for (const candidate of [
    request("/memory", { headers: { "sec-fetch-site": "none" } }),
    request("/workspace/example", { headers: { RSC: "1", "sec-fetch-site": "same-origin" } }),
    request("/apiary", { headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } }),
  ]) {
    const response = proxy(candidate);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  }
});

test("proxy rejects non-loopback page authority before rendering", async () => {
  for (const candidate of [
    request("/memory", { host: "attacker.example" }),
    request("/memory", { host: "attacker.example", origin: "http://attacker.example" }),
  ]) {
    const response = proxy(candidate);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Panel pages are only available from this Mac." });
  }
});

test("proxy retains the stricter API browser boundary and error contract", async () => {
  const denied = proxy(request("/api/memory", {
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  }));
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "Local API requests must come from Panel." });
  assert.equal(denied.headers.get("vary"), "Origin, Referer, Sec-Fetch-Site");

  const rebound = proxy(request("/api", { host: "attacker.example", origin: "http://attacker.example" }));
  assert.equal(rebound.status, 403);
  assert.deepEqual(await rebound.json(), { error: "Local API requests must come from Panel." });

  const cli = proxy(request("/api/memory"));
  assert.equal(cli.status, 200);
  assert.equal(cli.headers.get("x-middleware-next"), "1");

  const tauri = proxy(request("/api/memory", {
    headers: { origin: "tauri://localhost", "sec-fetch-site": "cross-site" },
  }));
  assert.equal(tauri.status, 200);
  assert.equal(tauri.headers.get("x-middleware-next"), "1");
});
