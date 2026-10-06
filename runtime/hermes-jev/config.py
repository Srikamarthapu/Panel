"""Profile-scoped settings. Keys never leave this module except for transport use."""
import json
import os
import math


def control_home():
    from hermes_constants import get_hermes_home
    return get_hermes_home() / "control-center"


def load_config(platform=None):
    try:
        raw = json.loads((control_home() / "jev.json").read_text())
        if not isinstance(raw, dict):
            raw = {}
    except (OSError, ValueError):
        raw = {}
    key = raw.get("apiKey") if isinstance(raw.get("apiKey"), str) else ""
    if not key:
        from agent.secret_scope import get_secret
        key = get_secret("TYPESAFE_API_KEY") or ""
    timeout = raw.get("timeoutMs", 1200)
    if not isinstance(timeout, (float, int)) or isinstance(timeout, bool) or not math.isfinite(timeout):
        timeout = 1200
    # Control uses its existing process-local opt-in. Gateway turns may use the
    # same private settings only when the Discord surface is explicitly enabled.
    # Other gateway/desktop surfaces remain outside this plugin's scope.
    discord = isinstance(platform, str) and platform.strip().lower() == "discord"
    scope_enabled = os.environ.get("HERMES_JEV_CONTROL") == "1" or (discord and raw.get("discordEnabled") is True)
    return {
        "enabled": scope_enabled and raw.get("enabled") is True,
        "discordEnabled": raw.get("discordEnabled") is True,
        "modelRouting": raw.get("modelRouting") is True,
        "apiKey": key,
        "toolSelection": raw.get("toolSelection", True) is True,
        "directDispatch": raw.get("directDispatch", True) is True,
        "monitorProgress": raw.get("monitorProgress", True) is True,
        "manageContext": raw.get("manageContext", True) is True,
        "timeoutMs": max(250, min(2000, int(timeout))),
        "minConfidence": 0.85,
    }
