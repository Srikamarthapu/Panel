"""Thin Control adapter over the installed Hermes ACP implementation.

The Control model field accepts exact provider model IDs, including IDs newer
than ACP's picker catalog. Constructing the native SessionManager with those
explicit arguments follows the same runtime-provider resolver as the CLI.
No credentials, native config, or installed Hermes source are changed.
"""
import asyncio
from collections.abc import Mapping
import inspect
import json
import math
import os
import sys

sys.path.insert(0, os.environ["HERMES_REPO"])
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from panel_delegation import handle_panel_method, make_acp_notifier, wrap_tool_progress_callback
from panel_profile_identity import apply_panel_profile_identity
from panel_profile_tools import panel_agents_available, register_panel_agents_tool
from acp_adapter import entry, server
from acp_adapter.session import SessionManager, _expand_acp_enabled_toolsets, _parse_model_config, _register_task_cwd, _translate_acp_cwd
from hermes_constants import parse_reasoning_effort
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names

required = {"model", "requested_provider", "session_id", "cwd"}
if not required.issubset(inspect.signature(SessionManager._make_agent).parameters):
    raise RuntimeError("Installed Hermes ACP is incompatible with Control; update the adapter before retrying.")
turn_parameters = list(inspect.signature(server.HermesACPAgent._finish_turn).parameters)
if turn_parameters != ["self", "state", "session_id", "conn", "result", "pre_turn_hermes_id", "streamed_message"]:
    raise RuntimeError("Installed Hermes ACP final-result contract is incompatible with Control.")


def _usage_integer(value):
    """Parse optional native counters without letting telemetry break a turn."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0 or not number.is_integer() or number > 1_000_000_000_000:
        return None
    return int(number)


def _usage_cost(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _usage_baseline(agent):
    return {
        "input": _usage_integer(getattr(agent, "session_input_tokens", None)),
        "output": _usage_integer(getattr(agent, "session_output_tokens", None)),
        "cost": _usage_cost(getattr(agent, "session_estimated_cost_usd", None)),
        "last_usage": getattr(agent, "_last_turn_usage", None),
    }


class ControlSessionManager(SessionManager):
    def _restore(self, session_id):
        db = self._get_db()
        row = db.get_session(session_id) if db is not None else None
        if not row or row.get("source") == "acp":
            return super()._restore(session_id)
        # Control's established conversations were created by Hermes CLI. ACP
        # rejects those solely because their source is not "acp". Adopt their
        # existing ID and native history in memory without rewriting that source
        # or replacing the durable transcript with a truncated UI history.
        if row.get("source") not in {"oneshot", "cli"}:
            return None
        metadata = _parse_model_config(row.get("model_config"))
        cwd = row.get("cwd") or metadata.get("cwd") or "."
        history = db.get_messages_as_conversation(session_id, repair_alternation=True)
        if not history and int(row.get("message_count") or 0) > 0:
            raise RuntimeError("Hermes could not restore the existing conversation history; it was not replaced.")
        agent = self._make_agent(
            session_id=session_id, cwd=cwd, model=row.get("model") or None,
            requested_provider=metadata.get("provider") or row.get("billing_provider"),
            base_url=metadata.get("base_url") or row.get("billing_base_url"),
            api_mode=metadata.get("api_mode"),
        )
        return self._install_state(session_id, agent, cwd, str(getattr(agent, "model", "") or row.get("model") or ""), history, persist=False)

    def update_cwd(self, session_id, cwd):
        state = self.get_session(session_id)
        if state is None:
            return None
        state.cwd = _translate_acp_cwd(cwd)
        _register_task_cwd(session_id, state.cwd)
        # A readiness probe is read-only with respect to the transcript. Native
        # update_cwd persists and can replace active messages for a fresh agent;
        # normal native turn persistence will record the cwd when work occurs.
        return state

    def _make_agent(self, **kwargs):
        model = os.environ.get("PANEL_ACP_MODEL", "")
        provider = os.environ.get("PANEL_ACP_PROVIDER", "")
        if model:
            kwargs["model"] = model
        if provider:
            kwargs["requested_provider"] = provider
            # A resumed session may carry an older provider's endpoint. Resolve
            # the explicitly selected provider rather than reusing that route.
            kwargs.pop("base_url", None)
            kwargs.pop("api_mode", None)
        # ACP's default is a coding-only tool profile. Control is a personal
        # assistant and must retain the user's existing CLI tool selection,
        # including configured computer and service connectors.
        config = load_config()
        resolved = _get_platform_tools(config, "cli")
        try:
            from agent.skill_utils import parse_config_string_list

            disabled = set(parse_config_string_list((config.get("agent") or {}).get("disabled_toolsets")) or [])
        except Exception:
            disabled = {"panel_agents"}
        if "panel_agents" not in disabled and register_panel_agents_tool() and panel_agents_available():
            resolved.add("panel_agents")
        mcp_servers = resolved & enabled_mcp_server_names(config)
        kwargs["enabled_toolsets"] = _expand_acp_enabled_toolsets(sorted(resolved - mcp_servers), sorted(mcp_servers))
        planning_only = os.environ.get("PANEL_DISABLE_TOOLS") == "1"
        if planning_only:
            kwargs["enabled_toolsets"] = []
        agent = super()._make_agent(**kwargs)
        if planning_only:
            agent.tools = []
            agent.valid_tool_names = set()
            agent.enabled_toolsets = []
        if model and agent.model != model:
            raise RuntimeError("Hermes did not retain the explicitly selected Control model.")
        agent.ephemeral_system_prompt = os.environ.get("PANEL_ACP_INSTRUCTIONS", "")
        agent.clarify_callback = lambda question, choices=None, multi_select=False: (
            "The user can answer in the next Talk or Chat turn. Ask the necessary concise question "
            "in your response and end this turn to wait for their answer. Do not invent an answer."
        )
        effort = os.environ.get("PANEL_ACP_REASONING", "")
        if effort:
            agent.reasoning_config = parse_reasoning_effort(effort)
        if callable(getattr(agent, "_invalidate_system_prompt", None)):
            agent._invalidate_system_prompt()
        return agent


class ControlACPAgent(server.HermesACPAgent):
    def __init__(self):
        super().__init__(session_manager=ControlSessionManager())

    async def prompt(self, prompt, session_id, **kwargs):
        # ACP metadata is passed to this handler as keyword arguments by its
        # router. Hermes adds ephemeral_system_prompt at API-call time, so the
        # mode instruction changes each turn without entering user history.
        turn_instructions = kwargs.pop("hermes-control/turn-instructions", None)
        run_id = kwargs.pop("hermes-control/run-id", None)
        state = await asyncio.to_thread(self.session_manager.get_session, session_id)
        if state is not None:
            state.agent._panel_usage_baseline = _usage_baseline(state.agent)
            profile_soul = os.environ.get("PANEL_AGENT_SOUL", "")
            if profile_soul:
                applied = await asyncio.to_thread(
                    apply_panel_profile_identity,
                    state.agent,
                    profile_soul,
                    soul_path=os.environ.get("PANEL_AGENT_SOUL_PATH", ""),
                )
                if not applied:
                    raise RuntimeError("The saved Panel agent identity could not be applied safely.")
            state.agent._panel_run_id = run_id if isinstance(run_id, str) and len(run_id) <= 128 else ""
            base = os.environ.get("PANEL_ACP_INSTRUCTIONS", "").strip()
            turn = turn_instructions.strip() if isinstance(turn_instructions, str) and len(turn_instructions) <= 20_000 else ""
            state.agent.ephemeral_system_prompt = "\n\n".join(part for part in (base, turn) if part)
        return await super().prompt(prompt=prompt, session_id=session_id, **kwargs)

    def _wire_turn_callbacks(self, state, session_id, conn, loop):
        callbacks = super()._wire_turn_callbacks(state, session_id, conn, loop)
        run_id = getattr(state.agent, "_panel_run_id", "")
        if callbacks.tool_progress_cb and run_id:
            notify = make_acp_notifier(conn, loop)
            wrapped = wrap_tool_progress_callback(
                state.agent,
                callbacks.tool_progress_cb,
                session_id=session_id,
                run_id=run_id,
                notify=notify,
            )
            callbacks.tool_progress_cb = wrapped
            state.agent.tool_progress_callback = wrapped
        return callbacks

    async def ext_method(self, method, params):
        if method == "panel/stop_agent" and isinstance(params, dict):
            session_id = params.get("sessionId", "")
            state = await asyncio.to_thread(self.session_manager.get_session, session_id)
            if state is None:
                return {"ok": False, "error": "unknown_session"}
            result = handle_panel_method(state.agent, method, params)
            if result is not None:
                return result
        return await super().ext_method(method, params)

    async def _finish_turn(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
        response = await super()._finish_turn(state, session_id, conn, result, pre_turn_hermes_id, streamed_message)
        # ACP end_turn alone does not carry an authoritative answer or native
        # error. This private notification closes the durable Control run only
        # after native persistence and tool completion have finished.
        cancelled = bool(state.cancel_event and state.cancel_event.is_set())
        error = str(result.get("error") or "")
        final = str(result.get("final_response") or "")
        if final.startswith("Error: ") and not error:
            error = final
        incomplete = result.get("failed") or result.get("partial") or result.get("completed") is False
        baseline = getattr(state.agent, "_panel_usage_baseline", None)
        usage = None
        current_turn_usage = getattr(state.agent, "_last_turn_usage", None)
        if (isinstance(baseline, dict) and isinstance(current_turn_usage, Mapping) and current_turn_usage
                and current_turn_usage is not baseline.get("last_usage")):
            current_input = _usage_integer(getattr(state.agent, "session_input_tokens", None))
            current_output = _usage_integer(getattr(state.agent, "session_output_tokens", None))
            current_cost = _usage_cost(getattr(state.agent, "session_estimated_cost_usd", None))
            # A provider/session reset makes a cumulative delta unknowable. Never
            # turn that reset into a fabricated zero-usage turn.
            if (current_input is not None and current_output is not None
                    and baseline.get("input") is not None and baseline.get("output") is not None
                    and current_input >= baseline["input"] and current_output >= baseline["output"]):
                input_tokens = current_input - baseline["input"]
                output_tokens = current_output - baseline["output"]
                cost_status = str(getattr(state.agent, "session_cost_status", "") or "").lower()
                baseline_cost = baseline.get("cost")
                cost = current_cost - baseline_cost if current_cost is not None and baseline_cost is not None and current_cost >= baseline_cost else None
                usage = {"inputTokens": input_tokens, "outputTokens": output_tokens,
                         "costUsd": cost if cost is not None and (cost > 0 or cost_status not in {"", "none", "unknown", "unavailable"}) else None}
        params = {
            "sessionId": session_id, "text": final, "error": error,
            "exit_code": 1 if error or cancelled or result.get("interrupted") or incomplete else 0,
        }
        if usage is not None:
            params["usage"] = usage
        print(json.dumps({"jsonrpc": "2.0", "method": "panel/turn_result", "params": params}), flush=True)
        return response


if __name__ == "__main__":
    server.HermesACPAgent = ControlACPAgent
    entry.main([])
