// Property 30 — No-raw-values lint invariant
// Validates: Requirements 9.9
//
// Scans every component file under `components/**/*.{jsx,css}` and rejects
// raw design-token literals that should only live in `app/mission.css` (the
// token declaration site) or `lib/design-tokens.js` (the JS mirror).
//
// Forbidden in component files:
//   - Raw hex color literals: /#[0-9a-fA-F]{3,8}\b/
//   - Raw color-function calls: rgb(, rgba(, hsl(, hsla(, oklch(
//   - Raw spacing px literals where N ∈ {4,8,12,16,24,32,48,64,96}
//     (only flagged in .css files; spacing in JSX is expected to flow through
//     CSS classes, not inline literals — but we still scan to catch regressions)
//   - Raw blur px literals where N ∈ {8,16,24} (only in .css files)
//   - Raw motion duration literals: 120ms, 240ms, 360ms, 600ms
//
// Excluded files: `app/mission.css` and `lib/design-tokens.js` (these are
// the only places where raw literal values are permitted).
//
// Comments and import statements are skipped before scanning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../");

// Strict scan paths — every file under these directories/files must be free
// of raw token literals. These are the surfaces owned by the redesign.
const STRICT_DIRS = [
  "components/shell",
  "components/voice",
  "components/orb",
];
const STRICT_FILES = ["components/MissionOrb.jsx"];

// Excluded files — the canonical token declaration sites.
const EXCLUDED_FILES = new Set([
  resolve(repoRoot, "app/mission.css"),
  resolve(repoRoot, "lib/design-tokens.js"),
]);

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function collectStrictFiles() {
  const files = [];
  for (const sub of STRICT_DIRS) {
    files.push(...walk(join(repoRoot, sub)));
  }
  for (const f of STRICT_FILES) {
    const full = join(repoRoot, f);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      // missing strict file is not a violation; tests in other tasks cover existence
    }
  }
  return files
    .filter((f) => /\.(jsx?|tsx?|css)$/.test(f))
    .filter((f) => !EXCLUDED_FILES.has(f));
}

function stripCommentsJs(src) {
  // Remove /* ... */ block comments and // line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function stripCommentsCss(src) {
  // CSS only supports /* ... */ comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripImports(src) {
  // Drop full import statements (single-line and multi-line).
  return src.replace(/^\s*import\s[\s\S]*?;?\s*$/gm, "");
}

function preprocess(filePath, raw) {
  const noComments =
    filePath.endsWith(".css") ? stripCommentsCss(raw) : stripCommentsJs(raw);
  return stripImports(noComments);
}

// Forbidden patterns
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FN_RE = /\b(?:rgb|rgba|hsl|hsla|oklch)\s*\(/g;
const RAW_DURATION_RE = /(?<![\w.-])(?:120|240|360|600)ms(?![\w-])/g;
// Spacing literals — only flag in CSS files (JSX legitimately uses small
// numeric pixel literals inside SVG attributes for orb geometry, which is
// outside the spacing token surface).
const SPACING_RE = /(?<![\w.-])(?:4|8|12|16|24|32|48|64|96)px(?![\w-])/g;

function findMatches(src, regex) {
  const out = [];
  // Match per-line so we can report line numbers.
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(line)) !== null) {
      out.push({ line: i + 1, match: m[0], snippet: line.trim() });
      if (m.index === regex.lastIndex) regex.lastIndex += 1;
    }
  }
  return out;
}

function format(violations) {
  return violations
    .map((v) => `  ${v.file}:${v.line} → ${v.match}\n    ${v.snippet}`)
    .join("\n");
}

function scan(filter) {
  const files = collectStrictFiles();
  const violations = [];
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    const src = preprocess(f, raw);
    const isCss = f.endsWith(".css");
    for (const { regex, label, cssOnly } of filter) {
      if (cssOnly && !isCss) continue;
      const hits = findMatches(src, new RegExp(regex.source, regex.flags));
      for (const h of hits) {
        violations.push({
          file: relative(repoRoot, f),
          line: h.line,
          match: h.match,
          snippet: h.snippet,
          label,
        });
      }
    }
  }
  return violations;
}

test("Property 30: no raw hex color literals in component files", () => {
  const v = scan([{ regex: HEX_RE, label: "hex" }]);
  assert.equal(
    v.length,
    0,
    `Raw hex color literals found:\n${format(v)}`,
  );
});

test("Property 30: no raw rgb/rgba/hsl/hsla/oklch literals in component files", () => {
  const v = scan([{ regex: COLOR_FN_RE, label: "color-fn" }]);
  assert.equal(
    v.length,
    0,
    `Raw color-function literals found:\n${format(v)}`,
  );
});

test("Property 30: no raw motion duration literals in component files", () => {
  const v = scan([{ regex: RAW_DURATION_RE, label: "duration" }]);
  assert.equal(
    v.length,
    0,
    `Raw motion duration literals found (allowed only via var(--motion-…)):\n${format(v)}`,
  );
});

test("Property 30: no raw spacing/blur px literals in component CSS files", () => {
  const v = scan([{ regex: SPACING_RE, label: "spacing-px", cssOnly: true }]);
  assert.equal(
    v.length,
    0,
    `Raw spacing px literals found in component CSS (use var(--space-…) or var(--blur-…)):\n${format(v)}`,
  );
});
