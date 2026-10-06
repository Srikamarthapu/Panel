import test from "node:test";
import assert from "node:assert/strict";
import { isLocalApiRequestAllowed } from "../../lib/local-request.js";

function request({
  url = "http://127.0.0.1:3000/api/voice/chat",
  host = "127.0.0.1:3000",
  headers = {},
} = {}) {
  return { url, headers: new Headers({ host, ...headers }) };
}

test("allows same-origin requests served from loopback", () => {
  assert.equal(
    isLocalApiRequestAllowed(
      request({ headers: { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" } })
    ),
    true
  );
});

test("allows the localhost to IPv4 loopback alias used by the desktop redirect", () => {
  assert.equal(
    isLocalApiRequestAllowed(
      request({
        url: "http://127.0.0.1:3000/api/models/switch",
        host: "127.0.0.1:3000",
        headers: { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
      })
    ),
    true
  );
});

test("rejects non-loopback hosts, including DNS-rebinding hostnames", () => {
  assert.equal(
    isLocalApiRequestAllowed(
      request({ url: "http://attacker.example/api/voice/chat", host: "attacker.example" })
    ),
    false
  );
  assert.equal(
    isLocalApiRequestAllowed(
      request({ url: "http://127.0.0.1:3000/api/voice/chat", host: "attacker.example" })
    ),
    false
  );
});

test("rejects a remote Origin even when the request targets loopback", () => {
  assert.equal(
    isLocalApiRequestAllowed(
      request({ headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } })
    ),
    false
  );
});

test("rejects null, malformed, and port-mismatched origins", () => {
  for (const origin of ["null", "not an origin", "http://localhost:3001"]) {
    assert.equal(isLocalApiRequestAllowed(request({ headers: { origin } })), false, origin);
  }
});

test("rejects cross-site fetch metadata when no matching local Origin is present", () => {
  assert.equal(
    isLocalApiRequestAllowed(request({ headers: { "sec-fetch-site": "cross-site" } })),
    false
  );
});

test("rejects a cross-site Referer", () => {
  assert.equal(
    isLocalApiRequestAllowed(request({ headers: { referer: "https://attacker.example/page" } })),
    false
  );
});

test("accepts the packaged Tauri origin only when the request host is loopback", () => {
  assert.equal(
    isLocalApiRequestAllowed(
      request({ headers: { origin: "tauri://localhost", "sec-fetch-site": "cross-site" } })
    ),
    true
  );
  assert.equal(
    isLocalApiRequestAllowed(
      request({
        url: "http://attacker.example:3000/api/voice/chat",
        host: "attacker.example:3000",
        headers: { origin: "tauri://localhost" },
      })
    ),
    false
  );
  assert.equal(
    isLocalApiRequestAllowed(request({ headers: { referer: "tauri://localhost/settings/voice" } })),
    true
  );
});
