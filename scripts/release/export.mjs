#!/usr/bin/env node
// Never clone private workspace history. Export only the reviewed manifest.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedSourceStat, REVIEWED_MANIFEST, validateLocalPythonImports, verifyReviewedManifest } from "./source-manifest.mjs";

const root = process.cwd();
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || destination === root || destination.startsWith(`${root}${path.sep}`) || fs.existsSync(destination)) {
  throw new Error("Pass a new destination directory outside this checkout; existing destinations are never overwritten.");
}
const manifest = verifyReviewedManifest(root);
validateLocalPythonImports(root, manifest);
for (const entry of manifest.files) {
  const info = checkedSourceStat(root, entry.path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-file: ${entry.path}`);
}

// Build a sibling staging directory, then rename it into place only after every
// copied byte still matches the reviewed manifest.
const staging = `${destination}.partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
try {
  fs.mkdirSync(staging, { recursive: false });
  for (const entry of manifest.files) {
    const target = path.join(staging, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = path.join(root, ...entry.path.split("/"));
    const data = fs.readFileSync(source);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    if (data.length !== entry.bytes || sha256 !== entry.sha256) {
      throw new Error(`Source changed while exporting: ${entry.path}`);
    }
    fs.writeFileSync(target, data, { flag: "wx", mode: fs.statSync(source).mode & 0o777 });
  }
  fs.mkdirSync(path.join(staging, "scripts", "release"), { recursive: true });
  fs.writeFileSync(path.join(staging, REVIEWED_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  fs.writeFileSync(path.join(staging, ".gitignore"), "node_modules/\n.next/\n.next-*/\ndata/\n.env\n.env.*\n!.env.example\nartifacts/\nlogs/\n*.log\ntest-results/\nplaywright-report/\n__pycache__/\n*.pyc\n.pytest_cache/\n.DS_Store\ngraphify-out/\n");
  fs.writeFileSync(path.join(staging, "SOURCE-MANIFEST.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest.files }, null, 2)}\n`);
  fs.renameSync(staging, destination);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
console.log(`Exported ${manifest.files.length} reviewed source files. No original Git history, local state, credentials, recordings, or native build artifacts were copied.`);
console.log(destination);
