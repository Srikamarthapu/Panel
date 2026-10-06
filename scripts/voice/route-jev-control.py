#!/usr/bin/env python3
"""Route a default Control Center turn through the installed Hermes configuration."""

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys


def _load_jev_package(workspace):
    package = workspace / "runtime" / "hermes-jev"
    spec = importlib.util.spec_from_file_location(
        "hermes_jev_control_route", package / "__init__.py",
        submodule_search_locations=[str(package)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Jev package unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main():
    request = json.loads(sys.stdin.read() or "{}")
    workspace = Path(__file__).resolve().parents[2]
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    repository = Path(os.environ.get("HERMES_REPO", home / "hermes-agent"))
    sys.path.insert(0, str(repository))

    with contextlib.redirect_stdout(sys.stderr):
        from hermes_cli.config import load_config
        hermes_config = load_config()
        jev_package = _load_jev_package(workspace)
        from hermes_jev_control_route import control_router
        result = control_router.choose_control_model(
            request.get("text"), hermes_config,
            explicit_provider=request.get("provider") or "",
            explicit_model=request.get("model") or "",
            session_id=request.get("sessionId") or "",
            turn_id=request.get("turnId") or "",
        )

    if isinstance(result, dict):
        print(json.dumps({"selected": True, "model": result["model"],
                          "provider": result["provider"], "decision": result.get("decision")}))
    else:
        print(json.dumps({"selected": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Route failure is deliberately fail-open; keep stdout machine-readable.
        print(json.dumps({"selected": False}))
