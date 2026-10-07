#!/usr/bin/env python3
"""Resolve Hermes' selected PM interpreter before starting Panel's ACP adapter.

Panel's compatibility venv can have a different Python ABI from Hermes' committed
runtime. This small stdlib entrypoint asks Hermes' own launcher for the selected
interpreter, then replaces itself with the adapter in that runtime. It never
installs dependencies; older Hermes trees without PM use their existing venv.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _compatibility_probe_code(adapter: Path) -> str:
    probe = r'''import inspect, json, re, runpy
result = {}
try:
    from acp_adapter import entry, server
    from acp_adapter.session import SessionManager, _expand_acp_enabled_toolsets, _parse_model_config, _register_task_cwd, _translate_acp_cwd
    import agent.system_prompt as system_prompt
    from agent.prompt_builder import _scan_context_content, _truncate_content
    required = {"model", "requested_provider", "session_id", "cwd"}
    if not required.issubset(inspect.signature(SessionManager._make_agent).parameters):
        raise RuntimeError("ACP agent factory signature changed")
    finish_parameters = list(inspect.signature(server.HermesACPAgent._finish_turn).parameters)
    expected_finish = ["self", "state", "session_id", "conn", "result", "pre_turn_hermes_id", "streamed_message"]
    if finish_parameters != expected_finish or not callable(getattr(server.HermesACPAgent, "_wire_turn_callbacks", None)):
        raise RuntimeError("ACP turn callback signature changed")
    if not all(callable(item) for item in (_expand_acp_enabled_toolsets, _parse_model_config, _register_task_cwd, _translate_acp_cwd)):
        raise RuntimeError("ACP session helpers are unavailable")
    if not callable(getattr(system_prompt, "_identity_parts", None)) or not callable(_scan_context_content) or not callable(_truncate_content):
        raise RuntimeError("Hermes primary identity hooks are unavailable")
    adapter = runpy.run_path(__PANEL_ADAPTER_PATH__, run_name="panel_acp_readiness")
    instance = adapter["ControlACPAgent"]()
    if not getattr(instance, "session_manager", None):
        raise RuntimeError("Panel ACP agent did not initialize")
    result["acp"] = {"ok": True, "message": "Hermes ACP signatures and per-profile identity hooks are compatible."}
except ModuleNotFoundError as error:
    name = str(getattr(error, "name", ""))
    result["acp"] = {"ok": False, "message": "Hermes ACP/profile support has a missing Python module: " + (name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name) else "unknown")}
except Exception as error:
    result["acp"] = {"ok": False, "message": "Hermes ACP/profile compatibility check failed: " + type(error).__name__}
try:
    from hermes_cli.provider_catalog import provider_catalog
    from hermes_cli.auth import PROVIDER_REGISTRY, resolve_api_key_provider_credentials
    from hermes_cli.providers import get_provider, custom_provider_slug
    from hermes_cli.models_catalog_static import _PROVIDER_MODELS
    descriptors = provider_catalog()
    required = ("slug", "label", "auth_type")
    missing = sorted({field for item in descriptors for field in required if not hasattr(item, field)})
    if missing:
        result["catalog"] = {"ok": False, "message": "Hermes provider descriptor is missing required fields: " + ", ".join(missing)}
    else:
        result["catalog"] = {"ok": True, "message": "Hermes provider registry imports and descriptor fields are compatible."}
except ModuleNotFoundError as error:
    name = str(getattr(error, "name", ""))
    result["catalog"] = {"ok": False, "message": "Hermes provider registry has a missing Python module: " + (name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", name) else "unknown")}
except Exception as error:
    result["catalog"] = {"ok": False, "message": "Hermes provider registry check failed: " + type(error).__name__}
print(json.dumps(result))'''
    return probe.replace("__PANEL_ADAPTER_PATH__", repr(str(adapter.resolve())))


def _runtime_command(repo: Path, code: str) -> list[str]:
    """Build the Hermes-managed command, falling back only when PM is absent."""
    sys.path.insert(0, str(repo))
    try:
        from hermes_cli._launchers import runtime_command
    except ModuleNotFoundError as error:
        # Pre-PM Hermes releases have no committed runtime selector. Do not
        # hide a broken PM package or missing third-party dependency as legacy.
        if (repo / "pm").exists() or error.name not in {"pm", "pm.environments", "hermes_cli", "hermes_cli._launchers"}:
            raise
        legacy_code = f"import sys; sys.path.insert(0, {str(repo)!r}); {code}"
        return [sys.executable, "-c", legacy_code]
    return runtime_command(repo, code=code)


def _main() -> None:
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    repo = Path(os.environ.get("HERMES_REPO") or (Path.home() / ".hermes" / "hermes-agent")).resolve()
    adapter = Path(__file__).with_name("panel-acp.py").resolve()

    if sys.argv[1:] == ["--check"]:
        code = _compatibility_probe_code(adapter)
    elif not sys.argv[1:]:
        code = f"import runpy; runpy.run_path({str(adapter)!r}, run_name='__main__')"
    else:
        raise SystemExit("Usage: launch-panel-acp.py [--check]")

    command = _runtime_command(repo, code)
    os.execv(command[0], command)


if __name__ == "__main__":
    _main()
