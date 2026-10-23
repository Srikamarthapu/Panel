#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildSourceManifest, compareManifest, readReviewedManifest, REVIEWED_MANIFEST, verifyReviewedManifest } from "./source-manifest.mjs";

const root = process.cwd();
const [command, candidateArg] = process.argv.slice(2);
const candidate = candidateArg ? path.resolve(candidateArg) : null;
function outsideCheckout(file) {
  if (!file || file === root || file.startsWith(`${root}${path.sep}`)) throw new Error("Pass a candidate path outside this checkout.");
}
function readCandidate() {
  outsideCheckout(candidate);
  return JSON.parse(fs.readFileSync(candidate, "utf8"));
}

if (command === "prepare") {
  outsideCheckout(candidate);
  fs.writeFileSync(candidate, `${JSON.stringify(buildSourceManifest(root), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(candidate);
} else if (command === "review") {
  const proposed = readCandidate();
  const actual = buildSourceManifest(root);
  if (JSON.stringify(proposed) !== JSON.stringify(actual)) throw new Error("Candidate does not match the current source.");
  const reviewedPath = path.join(root, REVIEWED_MANIFEST);
  const previous = fs.existsSync(reviewedPath) ? readReviewedManifest(root) : { version: 1, files: [] };
  const changes = compareManifest(previous, proposed);
  console.log(JSON.stringify({ files: proposed.files.length, ...changes }, null, 2));
} else if (command === "approve") {
  const proposed = readCandidate();
  if (JSON.stringify(proposed) !== JSON.stringify(buildSourceManifest(root))) throw new Error("Candidate does not match the current source.");
  fs.writeFileSync(path.join(root, REVIEWED_MANIFEST), `${JSON.stringify(proposed, null, 2)}\n`, { mode: 0o600 });
  console.log(`Approved ${proposed.files.length} reviewed source files.`);
} else if (command === "verify") {
  const reviewed = verifyReviewedManifest(root);
  console.log(`Verified ${reviewed.files.length} reviewed source files.`);
} else {
  throw new Error("Usage: manifest.mjs prepare|review|approve [candidate-path], or manifest.mjs verify");
}
