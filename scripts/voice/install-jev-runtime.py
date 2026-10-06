#!/usr/bin/env python3
"""Register the local Jev loop plugin with Hermes.

No credentials are copied into the plugin. It reads the existing server-only
Control settings at runtime; all other Hermes configuration is preserved.
The optional --discord flag also installs the gateway model-routing hook.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--discord", action="store_true", help="also install the optional Discord gateway model-route hook")
args = parser.parse_args()

workspace = Path(__file__).resolve().parents[2]
home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
repository = Path(os.environ.get("HERMES_REPO", home / "hermes-agent"))
source = workspace / "runtime" / "hermes-jev"
destination = home / "plugins" / "hermes-jev"
if not (source / "plugin.yaml").is_file():
    raise SystemExit("The Jev runtime plugin has not been built yet.")
sys.path.insert(0, str(repository))
from hermes_cli.plugins_cmd import cmd_enable

discord_route_installed = False
if args.discord:
    # The narrow gateway compatibility patch is opt-in. Control routing and the
    # tool-selection middleware do not require gateway source changes.
    subprocess.run([sys.executable, str(workspace / "scripts" / "voice" / "install-jev-discord-route.py")], check=True)
    discord_route_installed = True

directory = home / "control-center"
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
configuration = home / "config.yaml"
backup = directory / "config.before-jev.yaml"
if configuration.is_file() and not backup.exists():
    shutil.copyfile(configuration, backup)
    backup.chmod(0o600)
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.is_symlink() and destination.resolve() == source:
    pass
elif destination.exists() or destination.is_symlink():
    raise SystemExit("A different hermes-jev plugin already exists; it was left unchanged.")
else:
    destination.symlink_to(source, target_is_directory=True)
cmd_enable("hermes-jev", allow_tool_override=False)
receipt = directory / "jev-install.json"
scope = "Hermes Control and opt-in Discord" if args.discord else "Hermes Control"
receipt.write_text(json.dumps({"plugin": "hermes-jev", "source": str(source), "installedAt": datetime.now(timezone.utc).isoformat(), "scope": scope, "gatewayRouteHookInstalled": discord_route_installed}) + "\n")
receipt.chmod(0o600)
print(f"Jev loop integration installed for {scope}. Existing keys and provider settings were preserved.")
