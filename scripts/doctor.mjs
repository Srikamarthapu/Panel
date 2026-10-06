#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dataDirectory } from "../lib/work-store.js";
import { loadPanelEnvironment } from "./load-panel-env.mjs";

loadPanelEnvironment(false);
const home = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const repo = process.env.HERMES_REPO || path.join(home, "hermes-agent");
const python = path.join(repo, "venv/bin/python");
let failed = false;
function check(label, ok, remedy, required = true) {
  console.log(`${ok ? "OK" : required ? "NEEDS SETUP" : "OPTIONAL"}  ${label}${ok ? "" : ` — ${remedy}`}`);
  if (!ok && required) failed = true;
}
check("Node.js 22 or newer", Number(process.versions.node.split(".")[0]) >= 22, "Install Node.js 22 LTS or newer.");
check("macOS", process.platform === "darwin", "This release is tested on macOS. Other platforms are not yet verified.", false);
check("Hermes environment", fs.existsSync(python), "Install Hermes from its official repository, or set HERMES_REPO.");
check("Hermes configuration", fs.existsSync(path.join(home, "config.yaml")), "Run hermes setup and choose your model/provider.");
const native = spawnSync(python, ["scripts/voice/install-hermes-early-turn-result.py", "--check", "--json", "--repo", repo], { encoding: "utf8", timeout: 5000 });
check("Native turn-report support", native.status === 0, "Update Hermes; this version cannot provide Panel's early completion receipt.");
const command = spawnSync(process.env.HERMES_CLI_PATH || "hermes", ["--version"], { encoding: "utf8", timeout: 8000, env: { ...process.env, PATH: `${os.homedir()}/.local/bin:${repo}/venv/bin:${process.env.PATH || ""}` } });
check("Hermes command", command.status === 0, "Run hermes --version, or set HERMES_CLI_PATH to its executable.");
const catalogProbe = String.raw`import re, sys
sys.path.insert(0, sys.argv[1])
try:
    from hermes_cli.provider_catalog import provider_catalog
    from hermes_cli.auth import PROVIDER_REGISTRY, resolve_api_key_provider_credentials
    from hermes_cli.providers import get_provider, custom_provider_slug
    from hermes_cli.models_catalog_static import _PROVIDER_MODELS
    descriptors = provider_catalog()
    required = ("slug", "label", "auth_type")
    missing = sorted({field for item in descriptors for field in required if not hasattr(item, field)})
    if missing:
        print("Hermes provider descriptor is missing required fields: " + ", ".join(missing))
        raise SystemExit(1)
    print("Hermes provider registry imports and descriptor fields are compatible.")
except ModuleNotFoundError as error:
    name = str(getattr(error, "name", ""))
    print("Hermes provider registry has a missing Python module: " + (name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name) else "unknown"))
    raise SystemExit(1)
except Exception as error:
    print("Hermes provider registry check failed: " + type(error).__name__)
    raise SystemExit(1)`;
const catalogCompatibility = spawnSync(python, ["-c", catalogProbe, repo], { encoding: "utf8", timeout: 10_000 });
const catalogDiagnostic = catalogCompatibility.stdout?.trim().split("\n").filter(Boolean).at(-1);
check("Hermes model catalog compatibility", catalogCompatibility.status === 0, `${catalogDiagnostic || "Hermes provider registry could not be checked."} Repair the Hermes installation with hermes update, then rerun npm run doctor.`);
check("Speech recognition", Boolean(process.env.DEEPGRAM_API_KEY), "Add DEEPGRAM_API_KEY to .env.local for voice input; Chat works without it.", false);
let saved = {};
try { saved = JSON.parse(fs.readFileSync(path.join(dataDirectory(), "voice-config.json"), "utf8")); } catch { /* fresh install */ }
const eleven = Boolean(process.env.ELEVENLABS_API_KEY || saved.elevenlabsApiKeys?.length);
const edge = spawnSync("edge-tts", ["--version"], { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: `${os.homedir()}/.local/bin:${repo}/venv/bin:${process.env.PATH || ""}` } });
check("Speech playback", eleven || edge.status === 0, "Add ELEVENLABS_API_KEY or install edge-tts in the Hermes environment.", false);
console.log("\nThese are local compatibility checks, not live provider tests. Credentials are never printed.");
if (!failed) console.log("Ready to build: npm run build && npm start");
process.exitCode = failed ? 1 : 0;
