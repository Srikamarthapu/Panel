"""Offline contracts: no provider inference and no user tools execute."""
import importlib.util
import json
import sys
import inspect
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

PACKAGE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hermes_jev_test", PACKAGE / "__init__.py", submodule_search_locations=[str(PACKAGE)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from hermes_jev_test import config, runtime, decision, wire


def tool(name, properties=None, required=None, read_only=False):
    result = {"type": "function", "function": {"name": name, "description": "Tool " + name,
              "parameters": {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}}}
    if read_only:
        result["annotations"] = {"readOnlyHint": True}
    return result


def answer(choice, criteria, confidence=0.98):
    return {"type": "choice", "choice": choice, "confidence": confidence,
            "probabilities": {k: 1.0 if k == choice else 0.0 for k in criteria}}


def configured(monkeypatch, tmp_path):
    runtime._states.clear()
    runtime._health.clear()
    monkeypatch.setattr(runtime, "control_home", lambda: tmp_path)
    monkeypatch.setattr(runtime, "load_config", lambda platform=None: {"enabled": True, "toolSelection": True, "monitorProgress": True,
                                                                     "apiKey": "test", "timeoutMs": 1200, "minConfidence": 0.85})
    monkeypatch.setattr(runtime, "_redact", lambda value: value)
    monkeypatch.setattr(runtime, "installed_skills", lambda: {"google-workspace": "Google Calendar and Gmail"})
    events = []
    monkeypatch.setattr(runtime, "emit", lambda event, **kwargs: events.append(event))
    monkeypatch.setenv("HERMES_JEV_CONTROL", "1")
    return events


def dispatch(monkeypatch, selected, argument_choice="v0"):
    def decide(state, questions, config):
        result = {"next_tool": answer(selected, questions["next_tool"]["criteria"])}
        for key, question in questions.items():
            if key.startswith("arg_"):
                result[key] = answer(argument_choice, question["criteria"])
        return {"answers": result}
    callback = Mock(side_effect=decide)
    monkeypatch.setattr(runtime, "request_decisions", callback)
    return callback


def request(*tools):
    return {"model": "offline", "messages": [{"role": "system", "content": "Stable instructions"},
           {"role": "user", "content": "Look up my calendar"}], "tools": list(tools)}


CTX = {"api_mode": "chat_completions", "session_id": "offline-session", "turn_id": "offline-turn"}


def test_discord_activation_requires_both_shared_and_surface_opt_in(monkeypatch):
    with tempfile.TemporaryDirectory() as folder:
        tmp_path = Path(folder)
        monkeypatch.setattr(config, "control_home", lambda: tmp_path)
        monkeypatch.setenv("HERMES_JEV_CONTROL", "0")
        settings = {"enabled": True, "apiKey": "private-test-key"}
        (tmp_path / "jev.json").write_text(json.dumps(settings))
        assert config.load_config(platform="discord")["enabled"] is False
        assert config.load_config(platform="discord")["modelRouting"] is False

        settings.update(discordEnabled=True, modelRouting=True)
        (tmp_path / "jev.json").write_text(json.dumps(settings))
        assert config.load_config(platform="discord")["enabled"] is True
        assert config.load_config(platform="discord")["modelRouting"] is True
        assert config.load_config(platform="desktop")["enabled"] is False
        assert config.load_config()["enabled"] is False

        monkeypatch.setenv("HERMES_JEV_CONTROL", "1")
        assert config.load_config()["enabled"] is True
        settings["enabled"] = False
        (tmp_path / "jev.json").write_text(json.dumps(settings))
        assert config.load_config(platform="discord")["enabled"] is False
        assert config.load_config()["enabled"] is False


def test_discord_loop_and_tool_hooks_use_turn_scope_without_control_flag(configured, monkeypatch):
    base = runtime.load_config()
    monkeypatch.setenv("HERMES_JEV_CONTROL", "0")
    seen_platforms = []

    def load_for_platform(platform=None):
        seen_platforms.append(platform)
        return {**base, "enabled": platform == "discord"}

    monkeypatch.setattr(runtime, "load_config", load_for_platform)
    calls = dispatch(monkeypatch, "skills_list")
    inference = Mock(return_value="frontier response")
    discord = {**CTX, "platform": "discord"}
    response = runtime.select_next_tool(request(tool("skills_list")), inference, **discord)
    assert response.choices[0].message.tool_calls[0].function.name == "skills_list"
    assert calls.call_count == 1
    assert seen_platforms == ["discord"]

    # Hermes' post_tool_call and transform_tool_result hooks do not pass a
    # platform; the LLM call's turn identity carries the Discord scope.
    runtime.observe_tool("skills_list", {}, "ready", status="ok", **CTX)
    state = runtime._state(CTX)
    assert [item["tool"] for item in state["tools"]] == ["skills_list"]
    state["recovery"] = "Inspect the failure."
    assert "Inspect the failure." in runtime.annotate_result("skills_list", "ready", **CTX)

    desktop = {**CTX, "turn_id": "different-turn", "platform": "desktop"}
    assert runtime.select_next_tool(request(tool("skills_list")), inference, **desktop) == "frontier response"
    assert calls.call_count == 1
    runtime.observe_tool("skills_list", {}, "ignored", status="ok", **{k: v for k, v in desktop.items() if k != "platform"})
    assert runtime._state(desktop)["tools"] == []


def test_each_iteration_selects_live_tools_and_skips_only_grounded_reads(configured, monkeypatch):
    inference = Mock(return_value="frontier response")
    first = request(tool("skills_list"), tool("web_search", {"query": {"type": "string"}}, ["query"]))
    calls = dispatch(monkeypatch, "skills_list")
    synthetic = runtime.select_next_tool(first, inference, **CTX)
    assert synthetic.choices[0].message.tool_calls[0].function.name == "skills_list"
    inference.assert_not_called()
    second = {**first, "messages": [*first["messages"], {"role": "tool", "content": "Skills loaded"}]}
    dispatch(monkeypatch, "web_search")
    assert runtime.select_next_tool(second, inference, **CTX) == "frontier response"
    sent = inference.call_args.args[0]
    assert sent["tool_choice"] == {"type": "function", "function": {"name": "web_search"}}
    assert sent["tools"] is first["tools"]
    assert sent["messages"] is second["messages"]
    assert [e["mode"] for e in configured] == ["direct", "forced"]


def test_unknown_destructive_noarg_tool_never_skips_frontier(configured, monkeypatch):
    dispatch(monkeypatch, "delete_account")
    inference = Mock(return_value="normal")
    runtime.select_next_tool(request(tool("delete_account")), inference, **CTX)
    assert inference.call_count == 1
    assert configured[-1]["mode"] == "forced"


def test_direct_dispatch_toggle_is_respected(configured, monkeypatch):
    base_config = runtime.load_config()
    monkeypatch.setattr(runtime, "load_config", lambda platform=None: {**base_config, "directDispatch": False})
    dispatch(monkeypatch, "skills_list")
    inference = Mock(return_value="normal")
    runtime.select_next_tool(request(tool("skills_list")), inference, **CTX)
    assert inference.call_count == 1
    assert configured[-1]["mode"] == "forced"


def test_anthropic_auto_mode_is_eligible_for_real_selection(configured, monkeypatch):
    dispatch(monkeypatch, "skills_list")
    req = {"model": "offline", "tool_choice": {"type": "auto"},
           "messages": [{"role": "user", "content": "List skills"}],
           "tools": [{"name": "skills_list", "description": "Available skills", "input_schema": {"type": "object", "properties": {}}}]}
    inference = Mock()
    response = runtime.select_next_tool(req, inference, **{**CTX, "api_mode": "anthropic_messages"})
    assert response.content[0].name == "skills_list"
    inference.assert_not_called()


def test_installed_skill_name_is_closed_choice(configured, monkeypatch):
    dispatch(monkeypatch, "skill_view")
    inference = Mock()
    response = runtime.select_next_tool(request(tool("skill_view", {"name": {"type": "string"}}, ["name"])), inference, **CTX)
    assert json.loads(response.choices[0].message.tool_calls[0].function.arguments) == {"name": "google-workspace"}
    inference.assert_not_called()


def test_enum_arguments_are_supplied_values_not_model_generated_text(configured, monkeypatch):
    dispatch(monkeypatch, "read_status", "v1")
    inference = Mock()
    response = runtime.select_next_tool(request(tool("read_status", {"scope": {"type": "string", "enum": ["mine", "all"]}}, ["scope"], True)), inference, **CTX)
    assert json.loads(response.choices[0].message.tool_calls[0].function.arguments) == {"scope": "all"}
    inference.assert_not_called()


def test_uncertain_or_timeout_uses_unchanged_request(configured, monkeypatch):
    req = request(tool("skills_list"))
    monkeypatch.setattr(runtime, "request_decisions", lambda *args: {"answers": {}})
    inference = Mock(return_value="normal")
    assert runtime.select_next_tool(req, inference, **CTX) == "normal"
    assert inference.call_args.args[0] is req
    assert configured[-1]["reason"] == "invalid_choice_schema"


def test_same_request_retry_does_not_repeat_jev_or_force_failed_choice(configured, monkeypatch):
    decide = dispatch(monkeypatch, "web_search")
    req = request(tool("web_search", {"query": {"type": "string"}}, ["query"]))
    inference = Mock(return_value="normal")
    runtime.select_next_tool(req, inference, **CTX)
    runtime.select_next_tool(req, inference, **CTX)
    assert decide.call_count == 1
    assert inference.call_args.args[0] is req
    assert configured[-1]["reason"] == "unchanged_request_retry"


def test_recovery_is_attached_only_to_next_real_tool_result(configured, monkeypatch):
    for i in range(3):
        runtime.observe_tool("terminal", {"command": "offline"}, "same failure", status="error", **CTX)
    def decide(state, questions, config):
        return {"answers": {"next_tool": answer("skills_list", questions["next_tool"]["criteria"]),
                            "is_making_progress": {"type": "noul", "probability": 0.05},
                            "is_repeating_failed_strategy": {"type": "noul", "probability": 0.95},
                            "recovery": answer("inspect_error", decision.RECOVERY)}}
    monkeypatch.setattr(runtime, "request_decisions", decide)
    req = request(tool("skills_list"))
    inference = Mock(return_value="normal")
    runtime.select_next_tool(req, inference, **CTX)
    assert inference.call_args.args[0] is req
    annotated = runtime.annotate_result("terminal", "actual result", **CTX)
    assert annotated.startswith("actual result") and "Inspect the actual error" in annotated
    assert runtime.annotate_result("terminal", "next result", **CTX) is None


def test_progress_only_setting_runs_independently_every_three_results(configured, monkeypatch):
    base = runtime.load_config()
    monkeypatch.setattr(runtime, "load_config", lambda platform=None: {**base, "toolSelection": False, "monitorProgress": True})
    sent_questions = []
    def decide(state, questions, config):
        sent_questions.append(questions)
        return {"answers": {"is_making_progress": {"type": "noul", "probability": 0.05},
                            "is_repeating_failed_strategy": {"type": "noul", "probability": 0.95},
                            "recovery": answer("inspect_error", decision.RECOVERY)}}
    monkeypatch.setattr(runtime, "request_decisions", decide)
    inference = Mock(return_value="normal")
    req = request(tool("terminal"))
    for i in range(1, 7):
        runtime.observe_tool("terminal", {"command": "offline"}, "failure", status="error", **CTX)
        req = {**req, "messages": [*req["messages"], {"role": "tool", "content": "failure " + str(i)}]}
        runtime.select_next_tool(req, inference, **CTX)
        assert len(sent_questions) == i // 3
    assert all(set(q) == {"is_making_progress", "is_repeating_failed_strategy", "recovery"} for q in sent_questions)
    assert "Inspect the actual error" in inference.call_args.args[0]["messages"][-1]["content"]
    assert "tool_choice" not in inference.call_args.args[0]
    assert req["messages"][-1]["content"] == "failure 6"


def test_progress_recovery_reaches_the_current_inference_without_editing_history():
    original = {"messages": [{"role": "system", "content": "stable"}, {"role": "user", "content": "Fix it"},
                             {"role": "tool", "content": "Actual failure"}], "tools": []}
    before = json.dumps(original)
    adjusted = runtime.recovery_request(original, "chat_completions", decision.RECOVERY["inspect_error"])
    assert "Inspect the actual error" in adjusted["messages"][-1]["content"]
    assert json.dumps(original) == before
    assert adjusted["messages"][0] is original["messages"][0]
    assert adjusted["tools"] is original["tools"]


def test_selector_excludes_anthropic_thinking_signatures_and_media():
    original = {"messages": [{"role": "assistant", "content": [
        {"type": "thinking", "thinking": "private scratchpad", "signature": "private-signature"},
        {"type": "redacted_thinking", "data": "sealed reasoning"},
        {"type": "image", "source": {"type": "base64", "data": "private-image"}},
        {"type": "text", "text": "Visible answer"},
        {"type": "tool_use", "name": "skills_list", "input": {}}
    ]}]}
    state = json.dumps(runtime.request_state(original, "anthropic_messages", []))
    assert "Visible answer" in state and "skills_list" in state
    for excluded in ("scratchpad", "signature", "sealed reasoning", "private-image"):
        assert excluded not in state


def test_latest_user_goal_survives_long_tool_history_and_ignores_anthropic_results():
    rows = [{"role": "user", "content": [{"type": "text", "text": "Fix my calendar connection"}]}]
    rows += [{"role": "user", "content": [{"type": "tool_result", "content": "result " + str(i)}]} for i in range(20)]
    state = runtime.request_state({"messages": rows}, "anthropic_messages", [])
    assert len(state["recent_conversation"]) == 12
    assert state["latest_user_goal"] == "Fix my calendar connection"
    assert state["context_shortened"] is True


def test_synthetic_response_normalizes_through_real_hermes_transport():
    from agent.transports import get_transport
    for mode in ("chat_completions", "anthropic_messages", "codex_responses"):
        response = wire.tool_response("skills_list", {}, mode, "offline")
        transport = get_transport(mode)
        normalized = transport.normalize_response(response)
        assert normalized.finish_reason == "tool_calls"
        assert normalized.tool_calls[0].function.name == "skills_list"
        assert json.loads(normalized.tool_calls[0].function.arguments) == {}


def test_anthropic_thinking_remains_unchanged_when_forcing_is_unsupported():
    original = {"thinking": {"type": "adaptive"}, "tools": [], "messages": []}
    assert wire.force_tool(original, "skills_list", "anthropic_messages") is None
    assert original["thinking"] == {"type": "adaptive"}


def test_deepseek_v4_confident_tool_disables_thinking_for_only_the_handoff(configured, monkeypatch):
    original = request(tool("terminal", {"command": {"type": "string"}}, ["command"]))
    original.update({"model": "deepseek-v4-flash", "tool_choice": "auto",
                     "extra_body": {"thinking": {"type": "enabled"}}, "reasoning_effort": "medium"})
    dispatch(monkeypatch, "terminal")
    inference = Mock(return_value="frontier response")
    context = {**CTX, "provider": "deepseek", "model": "deepseek-v4-flash"}
    assert runtime.select_next_tool(original, inference, **context) == "frontier response"
    sent = inference.call_args.args[0]
    assert sent is not original
    assert sent["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "reasoning_effort" not in sent
    assert sent["tool_choice"] == {"type": "function", "function": {"name": "terminal"}}
    assert sent["messages"] is original["messages"] and sent["tools"] is original["tools"]
    assert original["extra_body"] == {"thinking": {"type": "enabled"}}
    assert original["reasoning_effort"] == "medium" and original["tool_choice"] == "auto"
    assert configured[-1]["reason"] == "hermes_fills_arguments"
    assert configured[-1]["evaluated"] is True


def test_deepseek_v4_default_thinking_blocks_forced_choice_but_explicit_off_allows_it():
    original = {"model": "deepseek-v4-pro", "messages": [], "tools": []}
    forced_default = wire.force_tool(original, "terminal", "chat_completions", provider="deepseek", model="deepseek-v4-pro")
    assert forced_default["extra_body"] == {"thinking": {"type": "disabled"}}
    assert forced_default["tool_choice"] == {"type": "function", "function": {"name": "terminal"}}
    assert original == {"model": "deepseek-v4-pro", "messages": [], "tools": []}
    assert wire.force_tool({**original, "reasoning_effort": "medium"}, None, "chat_completions",
                           provider="deepseek", model="deepseek-v4-pro") is None
    disabled = {**original, "extra_body": {"thinking": {"type": "disabled"}}}
    forced = wire.force_tool(disabled, "terminal", "chat_completions", provider="deepseek", model="deepseek-v4-pro")
    assert forced["tool_choice"] == {"type": "function", "function": {"name": "terminal"}}
    assert wire.force_tool(disabled, None, "chat_completions", provider="deepseek", model="deepseek-v4-pro") is None
    openai = {**original, "model": "gpt-5.5", "reasoning_effort": "high"}
    forced_openai = wire.force_tool(openai, "terminal", "chat_completions", provider="openai", model="gpt-5.5")
    assert forced_openai["tool_choice"] == {"type": "function", "function": {"name": "terminal"}}
    assert forced_openai["reasoning_effort"] == "high"


def test_new_prompt_gets_fresh_jev_decision_with_current_tools(configured, monkeypatch):
    calls = dispatch(monkeypatch, "terminal")
    inference = Mock(return_value="frontier response")
    first = request(tool("terminal", {"command": {"type": "string"}}, ["command"]))
    runtime.select_next_tool(first, inference, **{**CTX, "turn_id": "prompt-1"})
    second = request(tool("terminal", {"command": {"type": "string"}}, ["command"]))
    second["messages"][-1]["content"] = "A new request"
    runtime.select_next_tool(second, inference, **{**CTX, "turn_id": "prompt-2"})
    assert calls.call_count == 2
    assert inference.call_count == 2


def test_zero_tool_prompt_is_evaluated_before_hermes_generation(configured, monkeypatch):
    calls = dispatch(monkeypatch, decision.FINISH)
    original = request()
    inference = Mock(return_value="answer")
    assert runtime.select_next_tool(original, inference, **CTX) == "answer"
    assert calls.call_count == 1
    assert inference.call_args.args[0]["tool_choice"] == "none"
    assert original.get("tool_choice") is None
    assert configured[-1]["mode"] == "finish"


def test_deepseek_finish_uses_one_provider_call_for_malformed_dsml(configured, monkeypatch):
    dispatch(monkeypatch, decision.FINISH)
    original = request(tool("terminal", {"command": {"type": "string"}}, ["command"]))
    original.update({"model": "deepseek-v4-flash", "extra_body": {"thinking": {"type": "enabled"}}})
    malformed = wire.Obj(choices=[wire.Obj(message=wire.Obj(
        content='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="terminal"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>',
        tool_calls=None))])
    inference = Mock(return_value=malformed)
    context = {**CTX, "provider": "deepseek", "model": "deepseek-v4-flash"}
    assert runtime.select_next_tool(original, inference, **context) is malformed
    assert inference.call_count == 1
    assert original.get("tool_choice") is None and len(original["messages"]) == 2
    assert configured[-1]["reason"] == "provider_finish_keeps_tools_available"
    assert configured[-1]["confidence"] == 0.98


def test_deepseek_finish_does_not_retry_prose_or_native_tool_calls(configured, monkeypatch):
    dispatch(monkeypatch, decision.FINISH)
    original = request(tool("terminal"))
    original["model"] = "deepseek-v4-pro"
    context = {**CTX, "provider": "deepseek", "model": "deepseek-v4-pro"}
    prose = wire.Obj(choices=[wire.Obj(message=wire.Obj(content="Finished.", tool_calls=None))])
    inference = Mock(return_value=prose)
    assert runtime.select_next_tool(original, inference, **context) is prose
    assert inference.call_count == 1

    for content, tool_calls in [
        ("```xml\n<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>\n```", None),
        ("The provider printed <｜｜DSML｜｜ calls></｜｜DSML｜｜ calls> as an example.", None),
        (None, None),
        (None, [wire.Obj(function=wire.Obj(name="terminal"))]),
    ]:
        runtime._states.clear()
        response = wire.Obj(choices=[wire.Obj(message=wire.Obj(content=content, tool_calls=tool_calls))])
        candidate = Mock(return_value=response)
        assert runtime.select_next_tool(original, candidate, **context) is response
        assert candidate.call_count == 1


def test_deepseek_protocol_correction_does_not_reinvoke_downstream(configured, monkeypatch):
    dispatch(monkeypatch, decision.FINISH)
    original = request(tool("terminal"))
    original["model"] = "deepseek-v4-flash"
    malformed = wire.Obj(choices=[wire.Obj(message=wire.Obj(
        content="<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>", tool_calls=None))])
    inference = Mock(side_effect=[malformed, malformed])
    context = {**CTX, "provider": "deepseek", "model": "deepseek-v4-flash"}
    assert runtime.select_next_tool(original, inference, **context) is malformed
    assert inference.call_count == 1


def test_deepseek_protocol_correction_does_not_retry_provider_errors(configured, monkeypatch):
    dispatch(monkeypatch, decision.FINISH)
    original = request(tool("terminal"))
    original["model"] = "deepseek-v4-flash"
    inference = Mock(side_effect=RuntimeError("offline provider failure"))
    context = {**CTX, "provider": "deepseek", "model": "deepseek-v4-flash"}
    with unittest.TestCase().assertRaises(RuntimeError):
        runtime.select_next_tool(original, inference, **context)
    assert inference.call_count == 1


def test_schema_validation_fails_closed_on_external_refs_and_missing_fields():
    assert not decision.schema_valid({}, {"$ref": "https://external.invalid/schema"})
    assert not decision.schema_valid({}, {"type": "object", "required": ["path"]})


def test_no_frontier_choice_on_finish_but_frontier_still_writes_answer(configured, monkeypatch):
    dispatch(monkeypatch, decision.FINISH)
    inference = Mock(return_value="finished")
    assert runtime.select_next_tool(request(tool("skills_list")), inference, **CTX) == "finished"
    assert inference.call_args.args[0]["tool_choice"] == "none"


class Patches:
    def __init__(self, stack):
        self.stack = stack

    def setattr(self, owner, name, value):
        self.stack.enter_context(patch.object(owner, name, value))

    def setenv(self, name, value):
        self.stack.enter_context(patch.dict(os.environ, {name: value}))


class LoopTests(unittest.TestCase):
    pass


def _case(function):
    def run(self):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
            patches = Patches(stack)
            events = configured(patches, Path(folder))
            values = {"configured": events, "monkeypatch": patches}
            function(**{name: values[name] for name in inspect.signature(function).parameters})
    return run


for _name, _function in list(globals().items()):
    if _name.startswith("test_") and callable(_function):
        setattr(LoopTests, _name, _case(_function))


if __name__ == "__main__":
    unittest.main()
