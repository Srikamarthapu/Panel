#!/usr/bin/env node
/**
 * Node.js module loader that resolves Next.js-style "@/..." path aliases
 * to absolute paths under the project root.  This lets scripts import
 * route handlers and other source files that use @/ imports without
 * running the full Next.js build toolchain.
 *
 * Usage:
 *   node --import ./scripts/voice/alias-loader.mjs scripts/voice/fast-path-harness.mjs
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Resolve "@/..." against the real project root. Harnesses may chdir the
// process into a temp fixture dir (so process.cwd()-relative stores like
// data/voice-config.json read the fixture); HARNESS_ALIAS_ROOT pins the alias
// root to the actual repo so those imports still resolve. Defaults to cwd.
const ROOT = path.resolve(process.env.HARNESS_ALIAS_ROOT || process.cwd());
const TRY_EXTS = [".js", ".mjs", ".jsx"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.slice(2);
    let target = path.join(ROOT, relativePath);

    if (!path.extname(target)) {
      for (const ext of TRY_EXTS) {
        const candidate = target + ext;
        if (existsSync(candidate)) {
          target = candidate;
          break;
        }
      }
    }

    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
