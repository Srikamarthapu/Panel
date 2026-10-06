// T-0010 Law 9 (self-recovery): stamp a build id into BOTH the client bundle
// and the server runtime so the client can detect when the server has been
// redeployed and reload its own stale bundle — killing the "reload the Tauri
// window" chore.
//
// The id is fixed once per build: prefer an explicit HERMES_BUILD_ID (set by
// the deploy/launchd wrapper), else the short git SHA, else the build
// timestamp. It is exposed as NEXT_PUBLIC_BUILD_ID (readable in the browser)
// AND returned by generateBuildId so Next's own asset hashing lines up. The
// server reads the same NEXT_PUBLIC_BUILD_ID in /api/voice/status, so a rebuild
// changes the value in both places at once and the client sees the mismatch.
import { execSync } from "node:child_process";

function resolveBuildId() {
  if (process.env.HERMES_BUILD_ID) return String(process.env.HERMES_BUILD_ID);
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return `${sha}-${Date.now().toString(36)}`;
  } catch {
    /* not a git checkout — fall through */
  }
  return `build-${Date.now()}`;
}

const BUILD_ID = resolveBuildId();

const nextConfig = {
  agentRules: false,
  distDir: process.env.HERMES_NEXT_DIST_DIR || ".next",
  turbopack: { root: process.cwd() },
  reactStrictMode: true,
  generateBuildId: () => BUILD_ID,
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
};

export default nextConfig;
