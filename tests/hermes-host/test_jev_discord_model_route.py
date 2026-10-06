"""A Discord turn routes before AIAgent construction without losing session authority."""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from gateway.run_turn_runner import TurnRunner
from gateway.session import Platform, SessionSource
from gateway.turn_context import TurnContext


class _Agent:
    built_kwargs = None

    def __init__(self, **kwargs):
        type(self).built_kwargs = kwargs
        self.model = kwargs["model"]
        self.session_id = kwargs.get("session_id")
        self.tools = []
        self.context_compressor = SimpleNamespace(last_prompt_tokens=0, context_length=200_000)
        self.session_prompt_tokens = self.session_completion_tokens = 0

    def run_conversation(self, _message, **_kwargs):
        return {"final_response": "ok", "messages": []}


def _turn(platform=Platform.DISCORD):
    runner = MagicMock()
    runner.config = SimpleNamespace(streaming=None)
    runner._provider_routing = {}
    runner._agent_cache_lock = None
    runner._agent_cache = {}
    runner._session_db = runner._prefill_messages = None
    runner._pending_model_notes = runner._pending_skills_reload_notes = {}
    runner.session_store._entries = {}
    runner._get_system_prompt_for_channel.return_value = None
    runner._resolve_session_reasoning_config.return_value = None
    runner._resolve_session_service_tier.return_value = None
    runner._agent_config_signature.return_value = ("sig",)
    runner._extract_cache_busting_config.return_value = {}
    runner._refresh_fallback_model.return_value = [{"provider": "deepseek", "model": "deepseek-v4-pro"}]
    runner._consume_pending_native_image_paths.return_value = []
    runner._consume_pending_turn_sidecar_notes.return_value = []
    runner._session_model_override.return_value = None
    runner._resolve_session_agent_runtime.return_value = (
        "deepseek-flash", {"provider": "deepseek", "api_key": "test", "base_url": "https://api.deepseek.com/v1"},
    )
    runner._resolve_turn_agent_config.side_effect = lambda _msg, model, runtime: {
        "model": model, "runtime": dict(runtime),
    }
    for lane in ("_is_telegram_topic_lane", "_is_discord_auto_thread_lane", "_is_relay_discord_channel_lane"):
        getattr(runner, lane).return_value = False
    ctx = TurnContext(
        source=SessionSource(platform=platform, chat_id="c", user_id="u"),
        message="Analyze this code and implement the fix", history=[], session_id="sid", session_key="discord:c",
        user_config={}, AIAgent=_Agent, resolve_display_setting=lambda *_a: False,
        _run_still_current=lambda: True, _hooks_ref=SimpleNamespace(loaded_hooks=False),
    )
    return runner, ctx


def test_discord_route_selects_valid_model_before_agent_and_releases_old_cache():
    runner, ctx = _turn()
    runner._agent_cache[ctx.session_key] = (SimpleNamespace(model="deepseek-flash"), ("old",))
    with patch("hermes_cli.plugins.has_hook", return_value=True), \
         patch("hermes_cli.plugins.invoke_hook", return_value=[{"model": "deepseek-v4-pro", "provider": "deepseek"}]) as hook:
        result = TurnRunner(runner, ctx).run_sync()

    assert result["final_response"] == "ok"
    assert _Agent.built_kwargs["model"] == "deepseek-v4-pro"
    assert runner._resolve_session_reasoning_config.call_args.kwargs["model"] == "deepseek-v4-pro"
    assert runner._evict_cached_agent.call_args.args == (ctx.session_key,)
    assert hook.call_args.kwargs["candidates"] == ["deepseek-flash", "deepseek-v4-pro"]
    assert hook.call_args.kwargs["user_message"] == ctx.message


def test_explicit_model_override_and_invalid_route_keep_hermes_model():
    runner, ctx = _turn()
    runner._session_model_override.return_value = {"model": "deepseek-flash"}
    with patch("hermes_cli.plugins.invoke_hook") as hook:
        TurnRunner(runner, ctx).run_sync()
    hook.assert_not_called()
    assert _Agent.built_kwargs["model"] == "deepseek-flash"

    runner, ctx = _turn()
    with patch("hermes_cli.plugins.has_hook", return_value=True), \
         patch("hermes_cli.plugins.invoke_hook", return_value=[{"model": "foreign-model", "provider": "other"}]):
        TurnRunner(runner, ctx).run_sync()
    assert _Agent.built_kwargs["model"] == "deepseek-flash"


def test_jev_hook_timeout_or_exception_keeps_configured_model():
    for result, error in (([], None), (None, TimeoutError("Jev timed out"))):
        runner, ctx = _turn()
        with patch("hermes_cli.plugins.has_hook", return_value=True), \
             patch("hermes_cli.plugins.invoke_hook", return_value=result, side_effect=error):
            response = TurnRunner(runner, ctx).run_sync()
        assert response["final_response"] == "ok"
        assert _Agent.built_kwargs["model"] == "deepseek-flash"
        assert runner._resolve_session_reasoning_config.call_args.kwargs["model"] == "deepseek-flash"


def test_return_to_default_eviction_releases_cached_pro_agent():
    runner, ctx = _turn()
    runner._agent_cache[ctx.session_key] = (SimpleNamespace(model="deepseek-v4-pro"), ("old",))
    with patch("hermes_cli.plugins.has_hook", return_value=True), \
         patch("hermes_cli.plugins.invoke_hook", return_value=[{"model": "deepseek-flash", "provider": "deepseek"}]):
        response = TurnRunner(runner, ctx).run_sync()
    assert response["final_response"] == "ok"
    assert _Agent.built_kwargs["model"] == "deepseek-flash"
    assert runner._evict_cached_agent.call_args.args == (ctx.session_key,)


def test_model_derived_wire_mismatch_is_not_offered_as_candidate():
    runner, ctx = _turn()

    def derived_mode(_provider, model, _api_key=""):
        return "anthropic_messages" if model == "deepseek-v4-pro" else None

    with patch("hermes_cli.model_switch.model_derived_api_mode", side_effect=derived_mode), \
         patch("hermes_cli.plugins.has_hook", return_value=True), \
         patch("hermes_cli.plugins.invoke_hook") as hook:
        result = TurnRunner(runner, ctx).run_sync()

    assert result["final_response"] == "ok"
    assert _Agent.built_kwargs["model"] == "deepseek-flash"
    hook.assert_not_called()
