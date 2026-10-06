#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2] || ".");
const ignored = new Set([".git", "node_modules", ".next", "test-results", "playwright-report", "__pycache__", ".pytest_cache"]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["provider secret", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["AWS access ID", /\bAKIA[A-Z0-9]{16}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ["Discord webhook", /https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/],
  ["personal home path", /\/Users\/[a-zA-Z0-9._-]+\//],
];
const findings = [];
let count = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith(".next-")) continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file);
    if (entry.isSymbolicLink()) { findings.push({ file: relative, kind: "symlink" }); continue; }
    if (entry.isDirectory()) { if (["data", "logs", "artifacts", ".hermes-launcher"].includes(entry.name)) findings.push({ file: relative, kind: "local state directory" }); else walk(file); continue; }
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") { findings.push({ file: relative, kind: "environment file" }); continue; }
    const data = fs.readFileSync(file);
    count++;
    if (data.includes(0) || data.length > 5_000_000) continue;
    const text = data.toString("utf8");
    for (const [kind, pattern] of patterns) if (pattern.test(text)) findings.push({ file: relative, kind });
  }
}
walk(root);
console.log(JSON.stringify({ filesChecked: count, findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
