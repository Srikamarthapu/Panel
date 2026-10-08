"""Run with the installed Hermes Python; exercises its real ACP session base."""
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

os.environ.setdefault("HERMES_REPO", str(Path.home() / ".hermes/hermes-agent"))
adapter_path = Path(__file__).resolve().parents[2] / "scripts/voice/panel-acp.py"
spec = importlib.util.spec_from_file_location("panel_acp_under_test", adapter_path)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
from acp.agent.router import build_agent_router


class Database:
    def __init__(self, source="oneshot", history=None):
        self.row = {"id": "existing-cli", "source": source, "model": "chosen-model", "model_config": "{}", "cwd": "/tmp", "message_count": 3}
        self.history = history if history is not None else [
            {"role": "user", "content": "Run a harmless check."},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call", "type": "function", "function": {"name": "terminal", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call", "content": "ORCHID"},
        ]
        self.writes = []

    def get_session(self, session_id):
        return dict(self.row) if session_id == self.row["id"] else None

    def get_messages_as_conversation(self, session_id, **kwargs):
        assert kwargs == {"repair_alternation": True}
        return self.history

    def backfill_acp_session_cwd(self):
        return 0

    def replace_messages(self, *args, **kwargs):
        self.writes.append("replace")

    def update_session_meta(self, *args, **kwargs):
        self.writes.append("metadata")


class Manager(adapter.ControlSessionManager):
    def _make_agent(self, **kwargs):
        return SimpleNamespace(model="chosen-model", session_id=kwargs["session_id"])


class RestoreTests(unittest.TestCase):
    def test_existing_cli_history_is_adopted_without_any_persistence(self):
        db = Database()
        manager = Manager(db=db)
        state = manager.update_cwd("existing-cli", "/tmp")
        self.assertEqual(state.session_id, "existing-cli")
        self.assertIs(state.history, db.history)
        self.assertEqual(state.history[2]["tool_call_id"], "call")
        self.assertEqual(db.row["source"], "oneshot")
        self.assertEqual(db.writes, [])
        self.assertIs(manager.get_session("existing-cli"), state)

    def test_missing_history_is_not_silently_replaced(self):
        with self.assertRaisesRegex(RuntimeError, "not replaced"):
            Manager(db=Database(history=[])).get_session("existing-cli")

    def test_unrelated_transport_and_unknown_ids_are_not_adopted(self):
        manager = Manager(db=Database(source="discord"))
        self.assertIsNone(manager.get_session("existing-cli"))
        self.assertIsNone(manager.get_session("unknown"))


class TurnInstructionTests(unittest.IsolatedAsyncioTestCase):
    async def test_turn_result_reports_only_provider_confirmed_usage_deltas(self):
        control = adapter.ControlACPAgent()
        previous_usage = {"input_tokens": 10}
        agent = SimpleNamespace(
            session_input_tokens=120,
            session_output_tokens=25,
            session_estimated_cost_usd=0.006,
            session_cost_status="estimated",
            _last_turn_usage={"input_tokens": 70},
            _panel_usage_baseline={"input": 50, "output": 5, "cost": 0.002, "last_usage": previous_usage},
        )
        state = SimpleNamespace(agent=agent, cancel_event=None)

        async def finish_base(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
            return {"stopReason": "end_turn"}

        output = io.StringIO()
        with patch.object(adapter.server.HermesACPAgent, "_finish_turn", finish_base), redirect_stdout(output):
            response = await control._finish_turn(state, "native", object(), {"final_response": "Done", "completed": True}, None, "Done")

        event = json.loads(output.getvalue())
        self.assertEqual(response, {"stopReason": "end_turn"})
        self.assertEqual(event["params"]["usage"], {"inputTokens": 70, "outputTokens": 20, "costUsd": 0.004})

    async def test_turn_result_treats_reset_counters_as_unknown_instead_of_zero(self):
        control = adapter.ControlACPAgent()
        previous_usage = {"input_tokens": 10}
        state = SimpleNamespace(agent=SimpleNamespace(
            session_input_tokens=2,
            session_output_tokens=1,
            session_estimated_cost_usd=0.0,
            session_cost_status="unknown",
            _last_turn_usage={"input_tokens": 2},
            _panel_usage_baseline={"input": 50, "output": 5, "cost": 0.002, "last_usage": previous_usage},
        ), cancel_event=None)

        async def finish_base(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
            return {"stopReason": "end_turn"}

        output = io.StringIO()
        with patch.object(adapter.server.HermesACPAgent, "_finish_turn", finish_base), redirect_stdout(output):
            await control._finish_turn(state, "native", object(), {"final_response": "Done", "completed": True}, None, "Done")

        self.assertNotIn("usage", json.loads(output.getvalue())["params"])

    async def test_unknown_pricing_reports_tokens_without_claiming_zero_cost(self):
        control = adapter.ControlACPAgent()
        previous_usage = {"input_tokens": 10}
        state = SimpleNamespace(agent=SimpleNamespace(
            session_input_tokens=15,
            session_output_tokens=3,
            session_estimated_cost_usd=0.0,
            session_cost_status="unknown",
            _last_turn_usage={"input_tokens": 15},
            _panel_usage_baseline={"input": 10, "output": 1, "cost": 0.0, "last_usage": previous_usage},
        ), cancel_event=None)

        async def finish_base(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
            return {"stopReason": "end_turn"}

        output = io.StringIO()
        with patch.object(adapter.server.HermesACPAgent, "_finish_turn", finish_base), redirect_stdout(output):
            await control._finish_turn(state, "native", object(), {"final_response": "Done", "completed": True}, None, "Done")

        self.assertEqual(json.loads(output.getvalue())["params"]["usage"], {
            "inputTokens": 5, "outputTokens": 2, "costUsd": None,
        })

    async def test_turn_without_provider_usage_does_not_report_a_zero_delta(self):
        control = adapter.ControlACPAgent()
        previous_usage = {"input_tokens": 10}
        state = SimpleNamespace(agent=SimpleNamespace(
            session_input_tokens=50,
            session_output_tokens=5,
            session_estimated_cost_usd=0.002,
            session_cost_status="estimated",
            _last_turn_usage=None,
            _panel_usage_baseline={"input": 50, "output": 5, "cost": 0.002, "last_usage": previous_usage},
        ), cancel_event=None)

        async def finish_base(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
            return {"stopReason": "end_turn"}

        output = io.StringIO()
        with patch.object(adapter.server.HermesACPAgent, "_finish_turn", finish_base), redirect_stdout(output):
            response = await control._finish_turn(state, "native", object(), {"final_response": "Still answered.", "completed": True}, None, "Still answered.")

        event = json.loads(output.getvalue())
        self.assertEqual(response, {"stopReason": "end_turn"})
        self.assertEqual(event["params"]["text"], "Still answered.")
        self.assertNotIn("usage", event["params"])

    async def test_malformed_optional_counters_cannot_swallow_a_valid_final_answer(self):
        control = adapter.ControlACPAgent()
        previous_usage = {"input_tokens": 10}
        agent = SimpleNamespace(
            session_input_tokens="not-a-number",
            session_output_tokens=object(),
            session_estimated_cost_usd="NaN",
            session_cost_status="estimated",
            _last_turn_usage={"input_tokens": 12},
            _panel_usage_baseline={"input": 10, "output": 2, "cost": 0.001, "last_usage": previous_usage},
        )
        state = SimpleNamespace(agent=agent, cancel_event=None)

        async def finish_base(self, state, session_id, conn, result, pre_turn_hermes_id, streamed_message):
            return {"stopReason": "end_turn"}

        output = io.StringIO()
        with patch.object(adapter.server.HermesACPAgent, "_finish_turn", finish_base), redirect_stdout(output):
            response = await control._finish_turn(state, "native", object(), {"final_response": "Valid answer.", "completed": True}, None, "Valid answer.")

        event = json.loads(output.getvalue())
        self.assertEqual(response, {"stopReason": "end_turn"})
        self.assertEqual(event["params"]["text"], "Valid answer.")
        self.assertNotIn("usage", event["params"])
        self.assertEqual(adapter._usage_baseline(agent)["input"], None)
        self.assertEqual(adapter._usage_baseline(agent)["output"], None)
        self.assertEqual(adapter._usage_baseline(agent)["cost"], None)

    async def test_spoken_written_spoken_instructions_change_ephemerally_on_one_session(self):
        control = adapter.ControlACPAgent()
        history = [{"role": "user", "content": "Earlier native request."}]
        cached_system_prompt = "Persisted native system prompt."
        native_agent = SimpleNamespace(
            ephemeral_system_prompt="stale prior-turn instructions",
            _cached_system_prompt=cached_system_prompt,
        )
        state = SimpleNamespace(agent=native_agent, history=history)
        control.session_manager = SimpleNamespace(get_session=lambda session_id: state if session_id == "native" else None)
        captured = []

        async def capture_base_prompt(self, prompt, session_id, **kwargs):
            captured.append({
                "prompt": prompt,
                "session_id": session_id,
                "ephemeral": state.agent.ephemeral_system_prompt,
                "run_id": getattr(state.agent, "_panel_run_id", ""),
                "kwargs": kwargs,
                "history": list(state.history),
                "cached_system_prompt": state.agent._cached_system_prompt,
            })
            return "completed"

        modes = [
            ("voice-one", "Spoken Talk response: usually 1-3 short sentences; no tables or Markdown."),
            ("chat-two", "Written Talk or Chat response: use useful Markdown and give full detail."),
            ("voice-three", "Spoken Talk response: usually 1-3 short sentences; no tables or Markdown."),
        ]
        request_text = [{"type": "text", "text": "Current native request."}]
        router = build_agent_router(control)
        with patch.dict(os.environ, {"PANEL_ACP_INSTRUCTIONS": "Shared Control instructions."}):
            with patch.object(adapter.server.HermesACPAgent, "prompt", capture_base_prompt):
                for run_id, instructions in modes:
                    result = await router(
                        "session/prompt",
                        {
                            "prompt": request_text,
                            "sessionId": "native",
                            "_meta": {
                                "hermes-control/turn-instructions": instructions,
                                "hermes-control/run-id": run_id,
                            },
                        },
                        False,
                    )
                    self.assertEqual(result, "completed")

        self.assertEqual(len(captured), 3)
        self.assertEqual(captured[0]["ephemeral"], "Shared Control instructions.\n\n" + modes[0][1])
        self.assertEqual(captured[1]["ephemeral"], "Shared Control instructions.\n\n" + modes[1][1])
        self.assertEqual(captured[2]["ephemeral"], captured[0]["ephemeral"])
        self.assertEqual([item["run_id"] for item in captured], ["voice-one", "chat-two", "voice-three"])
        self.assertTrue(all(len(item["prompt"]) == 1 for item in captured))
        self.assertTrue(all(item["prompt"][0].text == "Current native request." for item in captured))
        self.assertTrue(all(item["session_id"] == "native" for item in captured))
        self.assertTrue(all("hermes-control/turn-instructions" not in item["kwargs"] for item in captured))
        self.assertTrue(all("hermes-control/run-id" not in item["kwargs"] for item in captured))
        self.assertTrue(all(item["history"] == history for item in captured))
        self.assertTrue(all(item["cached_system_prompt"] == cached_system_prompt for item in captured))
        self.assertIs(state.agent, native_agent)

    async def test_tool_callback_wrap_captures_the_run_id_for_late_child_updates(self):
        control = adapter.ControlACPAgent()
        parent = SimpleNamespace(_panel_run_id="voice-run", tool_progress_callback=None)
        state = SimpleNamespace(agent=parent)
        original_events = []
        notifications = []
        native_callback = lambda *args, **kwargs: original_events.append((args, kwargs))
        callbacks = SimpleNamespace(tool_progress_cb=native_callback)

        with patch.object(adapter.server.HermesACPAgent, "_wire_turn_callbacks", return_value=callbacks):
            with patch.object(
                adapter,
                "make_acp_notifier",
                return_value=lambda method, params: notifications.append((method, params)),
            ):
                result = control._wire_turn_callbacks(state, "native-session", object(), None)

        result.tool_progress_cb(
            "subagent.start",
            preview="Check the requested files",
            subagent_id="sa-0-a1b2c3d4",
            goal="Check the requested files",
            task_index=0,
        )
        self.assertIs(result, callbacks)
        self.assertIs(parent.tool_progress_callback, result.tool_progress_cb)
        self.assertEqual(len(original_events), 1)
        self.assertEqual(notifications[0][0], "panel/agent_update")
        self.assertEqual(notifications[0][1]["sessionId"], "native-session")
        self.assertEqual(notifications[0][1]["runId"], "voice-run")
        self.assertEqual(notifications[0][1]["agent"]["id"], "sa-0-a1b2c3d4")

    async def test_stop_agent_extension_uses_the_requested_native_session(self):
        control = adapter.ControlACPAgent()
        parent = SimpleNamespace(session_id="native-session")
        state = SimpleNamespace(agent=parent)
        control.session_manager = SimpleNamespace(get_session=lambda session_id: state if session_id == "native-session" else None)
        request = {"sessionId": "native-session", "runId": "voice-run", "agentId": "sa-0-a1b2c3d4"}
        with patch.object(adapter, "handle_panel_method", return_value={"ok": True, "status": "interrupt_requested"}) as handler:
            result = await control.ext_method("panel/stop_agent", request)
        self.assertEqual(result, {"ok": True, "status": "interrupt_requested"})
        handler.assert_called_once_with(parent, "panel/stop_agent", request)


if __name__ == "__main__":
    unittest.main()
