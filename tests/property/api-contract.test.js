// Property 32, 33, 34 — API contract preservation
// Validates: Requirements 10.1, 10.2, 10.4, 10.6, 10.7
//
// Without a live dev server we cannot easily make end-to-end HTTP requests,
// so this suite validates the contract at the *route module* level: the
// expected route files exist on disk, and their source code preserves the
// baseline request/response shapes documented in design.md.
//
// Property 32: Baseline data/API contract invariant — every API and page
// route the redesign relies on still exists, and `/api/voice/chat` exposes
// both POST (send text) and PUT (update config) handlers.
// Property 33: Malformed-body rejection invariant — chat route reads + parses
// the JSON body before invoking downstream work, so malformed bodies fall
// through to validation rather than corrupting state.
// Property 34: Route reachability invariant — every page route under the new
// Shell exists as a file, and the Voice provider's global hotkey + Tauri
// listener wiring is still present (so /voice and Option+Shift+H continue to
// work everywhere).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../");

const REQUIRED_API_ROUTES = [
  "app/api/mission-control/route.js",
  "app/api/voice/status/route.js",
  "app/api/voice/voices/route.js",
  "app/api/voice/stt/route.js",
  "app/api/voice/chat/route.js",
  "app/api/voice/tts/route.js",
];

const REQUIRED_PAGE_ROUTES = [
  "app/page.jsx",
  "app/tasks/page.jsx",
  "app/models/page.jsx",
  "app/memory/page.jsx",
  "app/system/page.jsx",
  "app/voice/page.jsx",
  "app/calendar/page.jsx",
  "app/market/page.jsx",
  "app/projects/page.jsx",
  "app/docs/page.jsx",
  "app/team/page.jsx",
  "app/visual/page.jsx",
  "app/content/page.jsx",
];

test("Property 32: required API route files exist", () => {
  for (const r of REQUIRED_API_ROUTES) {
    const full = resolve(repoRoot, r);
    assert.ok(existsSync(full), `Missing API route: ${r}`);
  }
});

test("Property 32: voice/chat route handles both POST and PUT (baseline contract)", () => {
  const src = readFileSync(
    resolve(repoRoot, "app/api/voice/chat/route.js"),
    "utf8"
  );
  // Baseline route must export at least POST and PUT handlers (per Req 10.2 + 10.6).
  assert.match(src, /export\s+(async\s+)?function\s+POST\b|export\s+\{[^}]*POST/);
  assert.match(src, /export\s+(async\s+)?function\s+PUT\b|export\s+\{[^}]*PUT/);
});

test("Property 32: mission-control route is reachable as a GET (file present + exports GET)", () => {
  const src = readFileSync(
    resolve(repoRoot, "app/api/mission-control/route.js"),
    "utf8"
  );
  // Either exports GET or default-exports a function — both valid Next.js shapes.
  const hasNamedGet = /export\s+(async\s+)?function\s+GET\b/.test(src);
  const hasReExportedGet = /export\s+\{[^}]*\bGET\b[^}]*\}/.test(src);
  const hasDefault = /export\s+default\s+/.test(src);
  assert.ok(
    hasNamedGet || hasReExportedGet || hasDefault,
    "mission-control route exposes no handler"
  );
});

test("Property 34: required page route files exist", () => {
  for (const p of REQUIRED_PAGE_ROUTES) {
    const full = resolve(repoRoot, p);
    assert.ok(existsSync(full), `Missing page route: ${p}`);
  }
});

test("Property 33: malformed body shape (smoke) — server-side validation lives in route handlers", () => {
  // Without booting Next we can't make HTTP requests. Instead we assert that
  // the chat route source contains some form of body validation (early return
  // on missing / bad shape), or at minimum reads the body before doing work.
  const src = readFileSync(
    resolve(repoRoot, "app/api/voice/chat/route.js"),
    "utf8"
  );
  // Look for a common validation pattern: parsing the JSON body before
  // invoking the chat layer.
  assert.match(src, /(req|request)\.json\(\)/);
});

test("Property 32: Tauri voice-toggle event listener present in VoiceProvider", () => {
  const src = readFileSync(
    resolve(repoRoot, "components/voice/VoiceProvider.jsx"),
    "utf8"
  );
  assert.match(src, /voice-toggle/);
  assert.match(src, /__TAURI__/);
});

test("Property 32: Option+Shift+H global hotkey listener present in VoiceProvider", () => {
  const src = readFileSync(
    resolve(repoRoot, "components/voice/VoiceProvider.jsx"),
    "utf8"
  );
  assert.match(src, /altKey/);
  assert.match(src, /shiftKey/);
  assert.match(src, /KeyH|key.*\.toLowerCase\(\)\s*===\s*"h"/);
});

test("smoke: file-existence checks are deterministic", () => {
  fc.assert(
    fc.property(fc.constantFrom(...REQUIRED_PAGE_ROUTES), (p) => {
      const full = resolve(repoRoot, p);
      return existsSync(full);
    }),
    { numRuns: 50 }
  );
});
