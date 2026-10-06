"""Offline checks against Hermes' actual ContextEngine contract."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import types
import unittest
from unittest.mock import patch

from agent.context_engine import ContextEngine


import sys
PACKAGE = types.ModuleType("jev_context_under_test")
PACKAGE.__path__ = [str(Path(__file__).parent)]
sys.modules[PACKAGE.__name__] = PACKAGE
SPEC = importlib.util.spec_from_file_location("jev_context_under_test.context_engine", Path(__file__).with_name("context_engine.py"))
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def call(call_id, name="file_read", arguments="{}"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def result(call_id, text):
    return {"role": "tool", "tool_call_id": call_id, "content": text}


def transcript(output="x" * 6_000, name="file_read"):
    return [
        {"role": "system", "content": "Keep the system exactly."},
        {"role": "user", "content": "Important original instructions."},
        {"role": "assistant", "content": "I am checking the files.", "tool_calls": [call("old", name)]},
        result("old", output),
        *[{"role": "user" if n % 2 == 0 else "assistant", "content": f"Recent {n}"} for n in range(6)],
    ]


class Native(ContextEngine):
    name = "compressor"

    def __init__(self):
        self.context_length = 100_000
        self.threshold_tokens = 50_000
        self.compression_count = 0
        self.last_prompt_tokens = 1_000
        self.last_total_tokens = 1_000
        self.compress_calls = []
        self.session_id = "test-session"
        self._compression_telemetry_seed = None

    def compress(self, messages, **kwargs):
        self.compress_calls.append((messages, kwargs))
        return messages

    def update_from_response(self, usage):
        self.last_prompt_tokens = usage["prompt_tokens"]

    def should_compress(self, prompt_tokens=None):
        return (self.last_prompt_tokens if prompt_tokens is None else prompt_tokens) > self.threshold_tokens

    def update_model(self, **kwargs):
        self.context_length = kwargs["context_length"]
        self.threshold_tokens = self.context_length // 2


class ContextEngineTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"HERMES_JEV_CONTROL": "1"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.requests = []
        self.events = []
        self.native = Native()
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)

    def engine(self, decision="truncate", response=None, enabled=True):
        def request(state, questions, config):
            self.requests.append((state, questions, config))
            if isinstance(response, Exception):
                raise response
            if response is not None:
                return response
            return {"answers": {
                qid: {"type": "choice", "choice": decision, "confidence": 0.99,
                      "probabilities": {choice: float(choice == decision) for choice in q["criteria"]}}
                for qid, q in questions.items()
            }}
        return MODULE.JevContextEngine(self.native, requester=request,
            config_loader=lambda: {"enabled": enabled, "manageContext": True, "minConfidence": 0.85},
            emitter=lambda event, **kwargs: self.events.append(event), archive_root=self.folder.name)

    def test_request_only_selection_preserves_all_prose_and_original(self):
        messages = transcript()
        original = copy.deepcopy(messages)
        selected = self.engine().select_context(messages, conversation_messages=messages)
        self.assertEqual(messages, original)
        self.assertLess(len(selected[3]["content"]), len(messages[3]["content"]))
        for index in [0, 1, 2, *range(4, 10)]:
            self.assertEqual(selected[index], original[index])
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])

    def test_drop_removes_paired_call_but_preserves_assistant_prose(self):
        messages = transcript("obsolete read")
        pairs = MODULE.collect_pairs(messages)
        selected = MODULE.apply_decisions(messages, pairs, {"old": "drop"})
        self.assertEqual(selected[2], {"role": "assistant", "content": "I am checking the files."})
        self.assertFalse(any(m.get("role") == "tool" for m in selected))
        self.assertIn("tool_calls", messages[2])

    def test_mutating_or_excerpted_result_cannot_be_dropped(self):
        for messages in [transcript("changed", "terminal"), transcript()]:
            pairs = MODULE.collect_pairs(messages)
            state, questions, _ = MODULE.build_questions(messages, pairs)
            self.assertNotIn("drop", questions["tool_0"]["criteria"])
            self.assertEqual(MODULE.apply_decisions(messages, pairs, {"old": "drop"}), messages)

    def test_recent_group_and_failures_are_kept(self):
        cases = [transcript('Error: token expired'), transcript('{"exit_code":1,"output":"failed"}'),
                 transcript('{"success":false}'), transcript('{"error":"oauth"}')]
        cases.append(transcript()[:-4])  # Call/result now cross the protected tail.
        for messages in cases:
            self.assertEqual(MODULE.collect_pairs(messages), [])
            self.assertIs(self.engine().select_context(messages), messages)
        self.assertEqual(len(self.requests), 0)

    def test_missing_duplicate_and_unrelated_results_are_kept(self):
        messages = transcript()
        missing = copy.deepcopy(messages)
        missing.pop(3)
        duplicate = copy.deepcopy(messages)
        duplicate.insert(4, copy.deepcopy(duplicate[3]))
        unrelated = copy.deepcopy(messages)
        unrelated[3]["tool_call_id"] = "other"
        unsupported = copy.deepcopy(messages)
        unsupported[2]["tool_calls"] = 7
        for candidate in [missing, duplicate, unrelated, unsupported]:
            self.assertEqual(MODULE.collect_pairs(candidate), [])

    def test_partial_parallel_group_drop_keeps_other_pair(self):
        messages = transcript("small read")
        messages[2]["tool_calls"].append(call("second", "terminal"))
        messages.insert(4, result("second", "already wrote the file"))
        selected = MODULE.apply_decisions(messages, MODULE.collect_pairs(messages), {"old": "drop"})
        self.assertEqual([c["id"] for c in selected[2]["tool_calls"]], ["second"])
        self.assertEqual(selected[3]["tool_call_id"], "second")

    def test_invalid_probability_or_uncertainty_uses_native_compression(self):
        bad = [float("nan"), 1.2, -0.1, True, "1", 0.6]
        for value in bad:
            answers = {"answers": {"tool_0": {"type": "choice", "choice": "truncate", "confidence": value,
                       "probabilities": {"keep": 0.0, "truncate": 1.0}}}}
            engine = self.engine(response=answers)
            messages = transcript()
            self.assertIs(engine.compress(messages, force=True), messages)
        self.assertEqual(len(self.native.compress_calls), len(bad))
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])

    def test_transport_failure_falls_back_and_cools_down(self):
        engine = self.engine(response=TimeoutError("secret should never be logged"))
        messages = transcript()
        self.assertIs(engine.select_context(messages), messages)
        self.assertIs(engine.select_context(messages), messages)
        self.assertEqual(len(self.requests), 1)
        self.assertNotIn("secret", json.dumps(self.events))
        engine.compress(messages, current_tokens=90_000, focus_topic="fix auth", memory_context="memory")
        self.assertEqual(len(self.native.compress_calls), 1)
        self.assertEqual(self.native.compress_calls[0][1]["focus_topic"], "fix auth")

    def test_enabled_scope_is_required(self):
        engine = self.engine(enabled=False)
        messages = transcript()
        self.assertIs(engine.select_context(messages), messages)
        with patch.dict(os.environ, {"HERMES_JEV_CONTROL": "0"}):
            self.assertIs(self.engine().select_context(messages), messages)
        self.assertFalse(self.requests)

    def test_retries_reuse_decision_but_new_goal_recomputes(self):
        engine = self.engine()
        messages = transcript()
        engine.select_context(messages)
        engine.select_context(messages)
        self.assertEqual(len(self.requests), 1)
        changed = copy.deepcopy(messages)
        changed[-2]["content"] = "The next task is different."
        engine.select_context(changed)
        self.assertEqual(len(self.requests), 2)

    def test_request_bytes_are_bounded_even_with_unicode(self):
        messages = [{"role": "system", "content": "system"}]
        for index in range(35):
            messages.extend([{"role": "assistant", "content": "", "tool_calls": [call(str(index))]},
                             result(str(index), "🧰" * 8_000)])
        messages.extend(transcript()[-6:])
        state, questions, included = MODULE.build_questions(messages, MODULE.collect_pairs(messages))
        payload = MODULE._json({"model": "jev-latest", "state": state, "questions": questions}).encode()
        self.assertLessEqual(len(payload), MODULE.MAX_REQUEST_BYTES)
        self.assertGreater(len(included), 0)
        self.assertLessEqual(len(included), MODULE.MAX_CANDIDATES)

    def test_persistent_reduction_archives_exact_original_with_private_mode(self):
        messages = transcript()
        selected = self.engine().compress(messages)
        self.assertLess(len(selected[3]["content"]), len(messages[3]["content"]))
        files = list(Path(self.folder.name).glob("*.json"))
        self.assertEqual(len(files), 1)
        self.assertEqual(json.loads(files[0].read_text()), messages)
        self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)
        self.assertFalse(self.native.compress_calls)
        self.assertEqual(self.native.compression_count, 1)

    def test_native_state_and_existing_policy_stay_in_sync(self):
        engine = self.engine()
        engine.update_from_response({"prompt_tokens": 60_000})
        self.assertTrue(engine.should_compress())
        self.assertEqual(engine.last_prompt_tokens, 60_000)
        engine._compression_telemetry_seed = {"source": "test"}
        self.assertEqual(self.native._compression_telemetry_seed, {"source": "test"})
        engine.update_model(model="different", context_length=80_000)
        self.assertEqual(engine.threshold_tokens, 40_000)
        self.assertIsInstance(engine, ContextEngine)

    def test_registered_request_selector_runs_through_native_middleware(self):
        from hermes_cli.middleware import apply_llm_request_middleware
        config_module = importlib.import_module("jev_context_under_test.config")
        fixture = self.engine()
        selector = MODULE.JevRequestContext(requester=fixture._requester,
            config_loader=fixture._config_loader, emitter=fixture._emitter, session_id="fixture")
        registered, hooks = {}, {}
        ctx = types.SimpleNamespace(
            register_middleware=lambda name, callback: registered.update({name: callback}),
            register_hook=lambda name, callback: hooks.update({name: callback}),
        )
        MODULE.register_context(ctx)
        messages = transcript()
        original = copy.deepcopy(messages)
        request = {"model": "fixture", "messages": messages, "tools": [{"fixture": "unchanged"}]}

        def invoke(kind, **kwargs):
            return [registered[kind](**kwargs)]

        with patch.object(config_module, "control_home", return_value=Path(self.folder.name)), \
             patch.object(MODULE, "JevRequestContext", return_value=selector), \
             patch("hermes_cli.plugins.has_middleware", return_value=True), \
             patch("hermes_cli.plugins.invoke_middleware", side_effect=invoke):
            outcome = apply_llm_request_middleware(request, api_mode="chat_completions", session_id="fixture")
            self.assertTrue(outcome.changed)
            self.assertLess(len(outcome.payload["messages"][3]["content"]), len(messages[3]["content"]))
            self.assertEqual(outcome.payload["tools"], request["tools"])
            self.assertEqual(outcome.original_payload, request)
            self.assertEqual(messages, original)
            self.assertEqual(outcome.trace[0]["reason"], "context_selection")
            self.assertFalse(self.native.compress_calls)
            self.assertFalse(hasattr(selector, "_native"))
            self.assertEqual(list(Path(self.folder.name).iterdir()), [])
            hooks["on_session_end"](session_id="fixture")
            self.assertNotIn((self.folder.name, "fixture"), MODULE._selectors)

    def test_discord_request_selector_uses_platform_without_control_flag(self):
        config_module = importlib.import_module("jev_context_under_test.config")
        fixture = self.engine()
        selector_class = MODULE.JevRequestContext
        seen_platforms = []

        def selector_for_platform(**kwargs):
            seen_platforms.append(kwargs["platform"])
            return selector_class(requester=fixture._requester,
                config_loader=fixture._config_loader, emitter=fixture._emitter, **kwargs)

        messages = transcript()
        with patch.dict(os.environ, {"HERMES_JEV_CONTROL": "0"}), \
             patch.object(config_module, "control_home", return_value=Path(self.folder.name)), \
             patch.object(MODULE, "JevRequestContext", side_effect=selector_for_platform):
            discord = MODULE.select_request_context({"messages": messages, "tools": []},
                api_mode="chat_completions", session_id="discord-fixture", platform="discord")
            self.assertEqual(discord["source"], "hermes-jev")
            self.assertLess(len(discord["request"]["messages"][3]["content"]), len(messages[3]["content"]))
            desktop = MODULE.select_request_context({"messages": messages, "tools": []},
                api_mode="chat_completions", session_id="desktop-fixture", platform="desktop")
            self.assertIsNone(desktop)
            MODULE.clear_request_context("discord-fixture")
            MODULE.clear_request_context("desktop-fixture")
        self.assertEqual(seen_platforms, ["discord", "desktop"])

    def test_request_middleware_leaves_unsupported_provider_formats_untouched(self):
        for mode in ["anthropic_messages", "codex_responses", "gemini"]:
            request = {"messages": transcript(), "tools": []}
            self.assertIsNone(MODULE.select_request_context(request, api_mode=mode))
        self.assertIsNone(MODULE.select_request_context({"messages": [{"type": "function_call_output"}]}))
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
