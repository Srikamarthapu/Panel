"""Fail-closed Panel profile capability enforcement for the Hermes ACP process."""

from __future__ import annotations

import json
import os
from typing import Any


POLICY_VERSION = 1
POLICY_TOOLSET = "panel-profile-scope"
SKILL_TOOLS = frozenset({"skills_list", "skill_view"})
FORBIDDEN_RESTRICTED_TOOLS = frozenset({"delegate_task", "panel_agents", "cronjob_manage", "skill_manage", "execute_code", "tool_call", "tool_search", "tool_describe"})
# Keep in sync with lib/agent-capabilities.js. These are the tool names Panel
# intentionally offers, not every implementation detail in the Hermes registry.
KNOWN_TOOLS = frozenset({
    "web_search", "web_extract", "read_file", "search_files", "write_file", "patch",
    "terminal", "process_manage", "browser_navigate", "browser_snapshot", "browser_click",
    "browser_type", "browser_scroll", "browser_back", "browser_press", "browser_get_images",
    "browser_vision", "browser_console", "vision_analyze", "image_generate", "text_to_speech",
    "computer_use", "todo_list", "memory", "session_search", "clarify",
    "manage_connections",
})


class PanelPolicyError(RuntimeError):
    pass


def _allow_scope(value: Any, label: str) -> tuple[str, ...]:
    if not isinstance(value, dict) or set(value) != {"mode", "ids"} or value.get("mode") != "allow":
        raise PanelPolicyError(f"Panel {label} policy must be an explicit allowlist.")
    ids = value.get("ids")
    if not isinstance(ids, list) or len(ids) > 500 or any(not isinstance(item, str) or not item for item in ids):
        raise PanelPolicyError(f"Panel {label} policy contains invalid capability IDs.")
    return tuple(dict.fromkeys(ids))


def load_panel_agent_policy(raw: str | None = None) -> dict[str, Any] | None:
    """Missing means legacy inherited access; any explicit malformed value fails."""
    raw = os.environ.get("PANEL_AGENT_POLICY", "") if raw is None else raw
    if raw == "":
        return None
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise PanelPolicyError("Panel agent capability policy is unreadable.") from exc
    if not isinstance(value, dict) or set(value) != {"version", "tools", "skills"} or value.get("version") != POLICY_VERSION:
        raise PanelPolicyError("Panel agent capability policy has an unsupported format.")
    tools = _allow_scope(value.get("tools"), "tool")
    skills = _allow_scope(value.get("skills"), "skill")
    unknown = set(tools) - KNOWN_TOOLS
    if unknown:
        raise PanelPolicyError(f"Panel agent tool policy contains unavailable IDs: {', '.join(sorted(unknown))}.")
    if set(tools) & FORBIDDEN_RESTRICTED_TOOLS:
        raise PanelPolicyError("Restricted Panel agents cannot receive delegation or indirect execution tools.")
    return {"version": POLICY_VERSION, "tools": tools, "skills": skills}


def allowed_tool_names(policy: dict[str, Any]) -> frozenset[str]:
    tools = set(policy["tools"])
    if policy["skills"]:
        tools.update(SKILL_TOOLS)
    tools.difference_update(FORBIDDEN_RESTRICTED_TOOLS)
    return frozenset(tools)


def install_policy_toolset(policy: dict[str, Any]) -> list[str]:
    from toolsets import create_custom_toolset

    tools = sorted(allowed_tool_names(policy))
    create_custom_toolset(POLICY_TOOLSET, "Panel profile capability allowlist", tools=tools)
    return [POLICY_TOOLSET]


def _skill_catalog() -> list[dict[str, Any]]:
    from tools import skills_tool

    return skills_tool._find_all_skills()


def validate_policy_skills(policy: dict[str, Any]) -> None:
    available = {str(item.get("name") or "") for item in _skill_catalog()}
    unknown = set(policy["skills"]) - available
    if unknown:
        raise PanelPolicyError(f"Panel agent skill policy contains unavailable IDs: {', '.join(sorted(unknown))}.")


def _policy_error(name: str) -> str:
    return json.dumps({"error": f"'{name}' is not allowed by this saved agent's capability policy."})


def install_runtime_enforcement(agent: Any, policy: dict[str, Any]) -> Any:
    """Filter schemas and gate every agent-loop/registry execution path."""
    allowed = allowed_tool_names(policy)
    agent.tools = [tool for tool in (getattr(agent, "tools", None) or []) if tool.get("function", {}).get("name") in allowed]
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
    agent.enabled_toolsets = [POLICY_TOOLSET]
    agent._panel_allowed_tool_names = allowed
    agent._panel_allowed_skill_names = frozenset(policy["skills"])
    _install_execution_gate(allowed)
    _install_skill_gate(frozenset(policy["skills"]))
    return agent


_execution_gate_installed = False
_active_allowed_tools: frozenset[str] = frozenset()


def _install_execution_gate(allowed: frozenset[str]) -> None:
    global _execution_gate_installed, _active_allowed_tools
    _active_allowed_tools = allowed
    if _execution_gate_installed:
        return
    _execution_gate_installed = True

    import model_tools
    from tools.registry import registry
    from agent import tool_executor

    original_handle = model_tools.handle_function_call
    original_dispatch = registry.dispatch
    original_parse = tool_executor._parse_tool_call

    def guarded_handle(function_name, *args, **kwargs):
        if function_name not in _active_allowed_tools:
            return _policy_error(function_name)
        return original_handle(function_name, *args, **kwargs)

    def guarded_dispatch(name, args, *positional, **kwargs):
        if name not in _active_allowed_tools:
            return _policy_error(name)
        return original_dispatch(name, args, *positional, **kwargs)

    def guarded_parse(agent, tool_call, *args, **kwargs):
        parsed = original_parse(agent, tool_call, *args, **kwargs)
        agent_allowed = getattr(agent, "_panel_allowed_tool_names", _active_allowed_tools)
        if parsed.name not in agent_allowed:
            parsed.scope_block = f"'{parsed.name}' is not allowed by this saved agent's capability policy."
        return parsed

    model_tools.handle_function_call = guarded_handle
    registry.dispatch = guarded_dispatch
    tool_executor._parse_tool_call = guarded_parse


_skill_gate_installed = False
_active_allowed_skills: frozenset[str] = frozenset()


def _install_skill_gate(allowed: frozenset[str]) -> None:
    global _skill_gate_installed, _active_allowed_skills
    _active_allowed_skills = allowed
    if _skill_gate_installed:
        return
    _skill_gate_installed = True

    from agent import system_prompt
    from tools import skills_tool

    original_list = skills_tool.skills_list
    original_view = skills_tool.skill_view

    def filtered_list(*args, **kwargs):
        try:
            result = json.loads(original_list(*args, **kwargs))
        except Exception:
            return json.dumps({"success": False, "error": "The allowed skill list could not be read."})
        rows = [row for row in result.get("skills", []) if row.get("name") in _active_allowed_skills]
        result["skills"] = rows
        result["count"] = len(rows)
        result["categories"] = sorted({row.get("category") for row in rows if row.get("category")})
        return json.dumps(result, ensure_ascii=False)

    def filtered_view(name, *args, **kwargs):
        if name not in _active_allowed_skills:
            return json.dumps({"success": False, "error": f"Skill '{name}' is not allowed by this saved agent's capability policy."})
        return original_view(name, *args, **kwargs)

    def filtered_prompt(agent):
        allowed_for_agent = getattr(agent, "_panel_allowed_skill_names", _active_allowed_skills)
        if not allowed_for_agent or "skill_view" not in getattr(agent, "valid_tool_names", set()):
            return ""
        rows = [row for row in _skill_catalog() if row.get("name") in allowed_for_agent]
        lines = [f"- {row['name']}: {row.get('description') or 'Installed Hermes skill.'}" for row in sorted(rows, key=lambda item: item["name"])]
        return (
            "## Skills\nOnly the following saved workflows are available to this profile. "
            "Load a relevant one with skill_view(name) before following it.\n"
            "<available_skills>\n" + "\n".join(lines) + "\n</available_skills>"
        )

    skills_tool.skills_list = filtered_list
    skills_tool.skill_view = filtered_view
    system_prompt._skills_prompt = filtered_prompt
    # Workspace-wide auto-load configuration must not inject a skill that is
    # absent from this profile's explicit allowlist.
    system_prompt._auto_load_parts = lambda _agent: []
