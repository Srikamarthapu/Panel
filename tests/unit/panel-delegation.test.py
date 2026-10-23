"""Run with the installed Hermes Python; delegation callbacks are faked and never execute a provider."""
import importlib.util
import asyncio
import os
from pathlib import Path
import sys
import threading
from types import ModuleType
from unittest.mock import Mock
from types import SimpleNamespace
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
HERMES_REPO = Path(os.environ.get("HERMES_REPO", str(Path.home() / ".hermes/hermes-agent")))
HERMES_AVAILABLE = (HERMES_REPO / "hermes_cli").is_dir()
os.environ["HERMES_REPO"] = str(HERMES_REPO)
if HERMES_AVAILABLE:
    sys.path.insert(0, str(HERMES_REPO))

module_path = REPO / "scripts/voice/panel_delegation.py"
spec = importlib.util.spec_from_file_location("panel_delegation_under_test", module_path)
panel_delegation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel_delegation)


def identity(agent_id="sa-0-a1b2c3d4", **extra):
    return {
        "subagent_id": agent_id,
        "parent_id": None,
        "goal": "Review the API boundary and report a concise finding.",
        "task_index": 0,
        "task_count": 1,
        "child_session_id": "child-session-1",
        "delegation_id": "delegation-1",
        "tool_count": 0,
        **extra,
    }


class PanelDelegationTests(unittest.TestCase):
    def setUp(self):
        panel_delegation._reset_for_tests()

    def tearDown(self):
        panel_delegation._reset_for_tests()

    def test_native_lifecycle_is_projected_and_sensitive_progress_is_omitted(self):
        parent = SimpleNamespace(session_id="native-session")
        original_events = []
        notifications = []

        def native_callback(*args, **kwargs):
            original_events.append((args, kwargs))

        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, native_callback, session_id=parent.session_id, run_id="run-1",
            notify=lambda method, params: notifications.append((method, params)),
        )
        safe_identity = identity()
        unsafe_goal = "Review access controls\n$ curl https://host.invalid -H 'Authorization: Bearer abc'"
        wrapped("subagent.spawn_requested", preview=unsafe_goal, **{**safe_identity, "goal": unsafe_goal})
        wrapped("subagent.start", preview=unsafe_goal, **{**safe_identity, "goal": unsafe_goal})
        wrapped(
            "subagent.tool", "terminal", "curl https://private.invalid/api",
            {"command": "curl https://private.invalid/api"},
            **{**safe_identity, "tool_count": 3, "output_tail": ("sk-" + "a" * 32)},
        )
        wrapped(
            "_thinking", "", "private chain of thought", None,
            **{**safe_identity, "reasoning": "private chain of thought"},
        )
        wrapped(
            "subagent.complete", preview="Done", status="completed",
            summary="The boundary is sound. `curl -H 'Authorization: Bearer token-value'`\n$ npm test",
            output_tail="private raw output", files_read=["/private/path"], **safe_identity,
        )

        self.assertEqual(len(original_events), 5)
        self.assertEqual([method for method, _ in notifications], [
            panel_delegation.AGENT_UPDATE_METHOD,
            panel_delegation.AGENT_UPDATE_METHOD,
            panel_delegation.AGENT_UPDATE_METHOD,
            panel_delegation.AGENT_UPDATE_METHOD,
        ])
        states = [params["agent"] for _, params in notifications]
        self.assertEqual([state["status"] for state in states], ["queued", "running", "running", "complete"])
        self.assertFalse(states[0]["canStop"])
        self.assertFalse(states[1]["canStop"])
        self.assertEqual(states[2]["toolCount"], 3)
        self.assertNotIn("curl", states[0]["task"])
        self.assertIn("The boundary is sound.", states[3]["result"])
        serialized = repr(notifications)
        for forbidden in ("private chain of thought", "private.invalid", "raw output", "sk-secret", "Authorization: Bearer", "files_read"):
            self.assertNotIn(forbidden, serialized)

    def test_late_child_updates_keep_the_originating_run_and_terminal_state(self):
        parent = SimpleNamespace(session_id="native-session")
        notifications = []
        notify = lambda method, params: notifications.append((method, params))
        first_run = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one", notify=notify,
        )
        later_run = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-two", notify=notify,
        )

        first_run("subagent.start", preview="Inspect the worker", **identity())
        later_run("subagent.start", preview="Inspect the panel", **identity("sa-1-b2c3d4e5", goal="Inspect the panel"))
        first_run("subagent.complete", status="interrupted", summary="Stopped safely", **identity())
        first_run("subagent.tool", "terminal", "private command", {"command": "private command"}, **identity(tool_count=4))

        self.assertEqual([params["runId"] for _, params in notifications], ["run-one", "run-two", "run-one"])
        self.assertEqual(notifications[-1][1]["agent"]["status"], "cancelled")
        self.assertNotIn("private command", repr(notifications))

    def test_sparse_terminal_event_keeps_the_started_worker_identity(self):
        parent = SimpleNamespace(session_id="native-session")
        notifications = []
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda method, params: notifications.append((method, params)),
        )
        wrapped("subagent.start", preview="Inspect the worker", **identity())
        sparse = identity()
        sparse.pop("delegation_id")
        sparse.pop("child_session_id")
        wrapped("subagent.complete", status="completed", summary="Done", **sparse)

        terminal = notifications[-1][1]["agent"]
        self.assertEqual(terminal["status"], "complete")
        self.assertEqual(terminal["delegationId"], "delegation-1")
        self.assertEqual(terminal["childSessionId"], "child-session-1")

    def test_stop_is_scoped_to_session_run_and_native_parent_ownership(self):
        parent = SimpleNamespace(session_id="native-session")
        notifications = []
        lock = threading.RLock()
        child = object()
        active = {"sa-0-a1b2c3d4": {"owner": parent, "agent": child, "delegation_id": "delegation-1"}}
        calls = []

        def owns(record, candidate):
            return record.get("owner") is candidate

        def interrupt(agent, reason):
            calls.append((agent, reason))
            return True

        api = (active, lock, owns, interrupt)
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda method, params: notifications.append((method, params)),
        )
        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            wrapped("subagent.start", preview="Inspect the worker", **identity())
            self.assertTrue(notifications[-1][1]["agent"]["canStop"])
            self.assertEqual(
                panel_delegation.stop_subagent(parent, "sa-0-a1b2c3d4", session_id="other-session", run_id="run-one")["error"],
                "parent_session_mismatch",
            )
            self.assertEqual(
                panel_delegation.stop_subagent(parent, "sa-0-a1b2c3d4", session_id="native-session", run_id="run-two")["error"],
                "agent_not_in_run",
            )
            accepted = panel_delegation.stop_subagent(
                parent, "sa-0-a1b2c3d4", session_id="native-session", run_id="run-one",
                delegation_id="delegation-1",
            )
            duplicate = panel_delegation.stop_subagent(
                parent, "sa-0-a1b2c3d4", session_id="native-session", run_id="run-one",
                delegation_id="delegation-1",
            )

        self.assertEqual(accepted, {"ok": True, "status": "interrupt_requested", "agentId": "sa-0-a1b2c3d4"})
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(calls, [(child, "Interrupted via Panel (sa-0-a1b2c3d4)")])
        self.assertTrue(panel_delegation._run_agents[("native-session", "run-one")]["sa-0-a1b2c3d4"]["stopRequested"])

    def test_stop_rejects_a_stale_native_worker_generation_before_interrupt(self):
        parent = SimpleNamespace(session_id="native-session")
        lock = threading.RLock()
        child_id = "sa-0-a1b2c3d4"
        child = object()
        active = {child_id: {"owner": parent, "agent": child, "delegation_id": "delegation-2"}}
        calls = []
        api = (
            active,
            lock,
            lambda record, candidate: record.get("owner") is candidate,
            lambda agent, reason: calls.append((agent, reason)) or True,
        )
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda *_args: None,
        )

        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            wrapped("subagent.start", preview="Inspect the worker", **identity(child_id))
            result = panel_delegation.stop_subagent(
                parent,
                child_id,
                session_id="native-session",
                run_id="run-one",
                delegation_id="delegation-1",
            )

        self.assertEqual(result, {"ok": False, "error": "agent_generation_mismatch"})
        self.assertEqual(calls, [])

    def test_unknown_panel_generation_cannot_bind_to_a_known_native_generation(self):
        parent = SimpleNamespace(session_id="native-session")
        notifications = []
        lock = threading.RLock()
        child_id = "sa-0-a1b2c3d4"
        child = object()
        calls = []
        active = {child_id: {"owner": parent, "agent": child, "delegation_id": "delegation-2"}}
        api = (
            active,
            lock,
            lambda record, candidate: record.get("owner") is candidate,
            lambda agent, reason: calls.append((agent, reason)) or True,
        )
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda method, params: notifications.append((method, params)),
        )
        sparse_identity = identity(child_id)
        sparse_identity.pop("delegation_id")

        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            wrapped("subagent.start", preview="Inspect the worker", **sparse_identity)
            result = panel_delegation.stop_subagent(
                parent, child_id, session_id="native-session", run_id="run-one",
            )

        self.assertFalse(notifications[-1][1]["agent"]["canStop"])
        self.assertEqual(result, {"ok": False, "error": "agent_generation_mismatch"})
        self.assertEqual(calls, [])

    def test_stop_interrupts_the_captured_native_child_if_the_public_id_is_reused(self):
        parent = SimpleNamespace(session_id="native-session")
        lock = threading.RLock()
        child_id = "sa-0-a1b2c3d4"
        original_child = object()
        replacement_child = object()
        active = {child_id: {"owner": parent, "agent": original_child, "delegation_id": "delegation-1"}}
        calls = []

        def interrupt(agent, reason):
            calls.append((agent, reason))
            active[child_id] = {"owner": parent, "agent": replacement_child, "delegation_id": "delegation-2"}
            with panel_delegation._run_agents_lock:
                panel_delegation._run_agents[("native-session", "run-one")][child_id] = {
                    "id": child_id,
                    "status": "running",
                    "delegationId": "delegation-2",
                }
            return True

        api = (active, lock, lambda record, candidate: record.get("owner") is candidate, interrupt)
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda *_args: None,
        )

        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            wrapped("subagent.start", preview="Inspect the worker", **identity(child_id))
            result = panel_delegation.stop_subagent(
                parent, child_id, session_id="native-session", run_id="run-one", delegation_id="delegation-1",
            )

        self.assertTrue(result["ok"])
        self.assertEqual(calls, [(original_child, "Interrupted via Panel (sa-0-a1b2c3d4)")])
        current = panel_delegation._run_agents[("native-session", "run-one")][child_id]
        self.assertNotIn("stopRequested", current)
        self.assertEqual(current["delegationId"], "delegation-2")

    def test_can_stop_tracks_live_registry_and_parent_ownership(self):
        parent = SimpleNamespace(session_id="native-session")
        notifications = []
        lock = threading.RLock()
        child_id = "sa-0-a1b2c3d4"
        active = {child_id: {"owner": parent, "delegation_id": "delegation-1"}}
        api = (active, lock, lambda record, candidate: record.get("owner") is candidate, lambda _sid: True)
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda method, params: notifications.append((method, params)),
        )

        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            wrapped("subagent.start", preview="Work", **identity(child_id))
            active.clear()
            wrapped("subagent.tool", "terminal", "private command", {"command": "private command"}, **identity(child_id))

        self.assertTrue(notifications[0][1]["agent"]["canStop"])
        self.assertFalse(notifications[1][1]["agent"]["canStop"])

    def test_queued_terminal_missing_and_foreign_children_cannot_be_stopped(self):
        parent = SimpleNamespace(session_id="native-session")
        notifications = []
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one",
            notify=lambda method, params: notifications.append((method, params)),
        )
        queued = identity("sa-0-a1b2c3d4")
        wrapped("subagent.spawn_requested", preview="Queued task", **queued)
        lock = threading.RLock()
        other_parent = SimpleNamespace(session_id="other-parent")
        foreign_id = "sa-1-deadbeef"
        active = {foreign_id: {"owner": other_parent}}
        calls = []
        api = (active, lock, lambda record, candidate: record.get("owner") is candidate,
               lambda agent_id: calls.append(agent_id) or True)
        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            queued_stop = panel_delegation.stop_subagent(
                parent, "sa-0-a1b2c3d4", session_id="native-session", run_id="run-one",
            )

        wrapped("subagent.start", preview="Queued task", **queued)
        wrapped("subagent.complete", status="completed", summary="Done", **queued)
        wrapped("subagent.start", preview="Foreign task", **identity(foreign_id, task_index=1))
        with patch.object(panel_delegation, "_delegation_control_api", return_value=api):
            terminal = panel_delegation.stop_subagent(
                parent, "sa-0-a1b2c3d4", session_id="native-session", run_id="run-one",
            )
            foreign = panel_delegation.stop_subagent(
                parent, foreign_id, session_id="native-session", run_id="run-one",
            )
            missing = panel_delegation.stop_subagent(
                parent, "sa-9-deadbeef", session_id="native-session", run_id="run-one",
            )

        self.assertEqual(queued_stop["error"], "agent_not_running")
        self.assertEqual(terminal["error"], "agent_not_running")
        self.assertEqual(foreign["error"], "agent_not_active")
        self.assertEqual(missing["error"], "agent_not_in_run")
        self.assertEqual(calls, [])

    def test_missing_native_capability_degrades_without_crashing(self):
        self.assertIsNone(panel_delegation.make_acp_notifier(SimpleNamespace(), None))
        parent = SimpleNamespace(session_id="native-session")
        wrapped = panel_delegation.wrap_tool_progress_callback(
            parent, lambda *args, **kwargs: None, session_id=parent.session_id, run_id="run-one", notify=lambda *args: None,
        )
        wrapped("subagent.start", preview="Task", **identity())
        with patch.object(panel_delegation, "_delegation_control_api", return_value=None):
            capability = panel_delegation.delegation_capability()
            result = panel_delegation.handle_panel_method(
                SimpleNamespace(session_id="native-session"), panel_delegation.STOP_AGENT_METHOD,
                {"sessionId": "native-session", "runId": "run-one", "agentId": "sa-0-a1b2c3d4"},
            )
        self.assertFalse(capability["available"])
        self.assertEqual(result["error"], "delegation_control_unavailable")

    def test_terminal_notification_remains_pending_until_a_later_ack(self):
        event_loop = asyncio.new_event_loop()
        loop_thread = threading.Thread(target=event_loop.run_forever)
        loop_thread.start()
        delivered = threading.Event()
        calls = []

        async def ext_method(method, params):
            calls.append((method, params))
            if len(calls) == 1:
                await asyncio.Event().wait()
            if len(calls) == 2:
                raise RuntimeError("synthetic connection failure")
            if len(calls) == 3:
                return {"ok": False}
            delivered.set()
            return {"ok": True}

        # Terminal delivery only requires the acknowledged request transport;
        # progress notifications are an independent best-effort capability.
        conn = SimpleNamespace(ext_method=ext_method)
        notifier = panel_delegation.make_acp_notifier(conn, event_loop)
        scheduled = []

        def schedule(awaitable, loop, **_kwargs):
            future = asyncio.run_coroutine_threadsafe(awaitable, loop)
            scheduled.append(future)
            return future

        agent_module = ModuleType("agent")
        async_utils_module = ModuleType("agent.async_utils")
        async_utils_module.safe_schedule_threadsafe = schedule
        agent_module.async_utils = async_utils_module

        try:
            with patch.dict(sys.modules, {"agent": agent_module, "agent.async_utils": async_utils_module}), patch.object(panel_delegation, "_TERMINAL_NOTIFICATION_TIMEOUT_SECONDS", 0.05):
                accepted = notifier(panel_delegation.AGENT_UPDATE_METHOD, {
                    "sessionId": "native-session", "runId": "run-one",
                    "agent": {"id": "sa-0-a1b2c3d4", "delegationId": "delegation-1", "status": "complete"},
                })
                self.assertTrue(accepted)
                self.assertTrue(delivered.wait(3), "pending terminal notification was not retried to acknowledgement")
                scheduled[0].result(timeout=2)
            self.assertEqual(len(calls), 4)
        finally:
            event_loop.call_soon_threadsafe(event_loop.stop)
            loop_thread.join(timeout=2)
            event_loop.close()

    def test_installed_runtime_exposes_native_child_controls(self):
        if not HERMES_AVAILABLE:
            self.skipTest("installed Hermes runtime is not present")
        capability = panel_delegation.delegation_capability()
        self.assertTrue(capability["available"])
        self.assertTrue(capability["individualStop"])
        self.assertEqual(capability["agentUpdateMethod"], "panel/agent_update")
        self.assertEqual(capability["stopMethod"], "panel/stop_agent")


if __name__ == "__main__":
    unittest.main()
