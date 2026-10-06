#!/usr/bin/env python3
"""Read manifests and safe configuration metadata; never import plugin code."""
import json
import os
from pathlib import Path
import sys
import yaml

HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
REPO = Path(os.environ.get("HERMES_REPO", str(HOME / "hermes-agent"))).expanduser()
LIMIT = 500
warnings = set()

def text(value, maximum=600):
    return str(value or "").strip()[:maximum] if isinstance(value, (str, int, float)) else ""

def read_yaml(file):
    try:
        if file.stat().st_size > 256 * 1024:
            warnings.add("Some oversized metadata files were omitted.")
            return {}
        value = yaml.safe_load(file.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, yaml.YAMLError):
        return {}

config = read_yaml(HOME / "config.yaml")
plugins_config = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
enabled = plugins_config.get("enabled") or []
disabled = plugins_config.get("disabled") or []
if not isinstance(enabled, list): enabled = []
if not isinstance(disabled, list): disabled = []

def scan_skills(root):
    result = []
    if not root.is_dir(): return result
    # Do not follow directory links outside the skill root or recurse forever.
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in {"node_modules", "__pycache__"})
        if len(Path(directory).relative_to(root).parts) >= 6: dirs[:] = []
        if "SKILL.md" not in files: continue
        file = Path(directory) / "SKILL.md"
        try:
            if not file.resolve().is_relative_to(root.resolve()) or file.stat().st_size > 256 * 1024: continue
            source = file.read_text()
            front = source.split("---", 2)
            metadata = yaml.safe_load(front[1]) if len(front) == 3 and not front[0].strip() else {}
            if not isinstance(metadata, dict): metadata = {}
            key = str(file.parent.relative_to(root))
            result.append({"id": key, "name": text(metadata.get("name") or file.parent.name, 120), "description": text(metadata.get("description")), "category": key.split("/")[0] if "/" in key else "General", "source": "Hermes skills", "status": "Installed"})
            if len(result) >= LIMIT:
                warnings.add("The inventory is limited to 500 entries per category."); break
        except (OSError, ValueError, yaml.YAMLError):
            warnings.add("Some skill metadata could not be read.")
    return sorted(result, key=lambda row: row["name"].lower())

def scan_plugins(root, source):
    result = []
    if not root.is_dir(): return result
    def visit(folder, depth=0, prefix=""):
        if depth > 1 or len(result) >= LIMIT: return
        try: children = sorted(folder.iterdir())
        except OSError: return
        for child in children:
            if child.name.startswith((".", "__")) or not child.is_dir(): continue
            key = prefix + child.name
            native = next((child / name for name in ("plugin.yaml", "plugin.yml") if (child / name).is_file()), None)
            portable = child / "plugin.json"
            metadata = read_yaml(native) if native else read_yaml(portable) if portable.is_file() else None
            if metadata is None:
                visit(child, depth + 1, key + "/"); continue
            name = text(metadata.get("name") or child.name, 120)
            status = "Disabled in settings" if name in disabled or key in disabled else "Enabled in settings" if name in enabled or key in enabled else "Installed"
            result.append({"id": source + ":" + key, "name": name, "description": text(metadata.get("description")), "version": text(metadata.get("version"), 80), "source": source, "status": status})
    visit(root)
    return result

skills = scan_skills(HOME / "skills")
plugins = scan_plugins(REPO / "plugins", "Bundled") + scan_plugins(HOME / "plugins", "User installed")
print(json.dumps({"skills": skills, "plugins": plugins, "warnings": sorted(warnings), "runtime": {"name": "Hermes Agent", "configurationFound": (HOME / "config.yaml").is_file(), "environmentFound": (REPO / "venv/bin/python").is_file(), "home": str(HOME), "repository": str(REPO)}, "scope": "Local Hermes skill files and plugin manifests. Project-local skills and Python entry-point plugins are not included. Installed or enabled does not prove a plugin loaded successfully."}))
