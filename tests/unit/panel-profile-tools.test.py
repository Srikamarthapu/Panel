"""Adapter-only tests; the mocked CLI never starts a provider or changes app data."""

import json
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
HERMES_REPO = Path(os.environ.get("HERMES_REPO", str(Path.home() / ".hermes/hermes-agent")))
HERMES_AVAILABLE = (HERMES_REPO / "hermes_cli").is_dir()
os.environ["HERMES_REPO"] = str(HERMES_REPO)
if HERMES_AVAILABLE:
    sys.path.insert(0, str(HERMES_REPO))
sys.path.insert(0, str(REPO / "scripts/voice"))
import panel_profile_tools as tool

adapter_path = REPO / "scripts/voice/panel-acp.py"
adapter = None
if HERMES_AVAILABLE:
    adapter_spec = importlib.util.spec_from_file_location("panel_profile_tool_adapter", adapter_path)
    adapter = importlib.util.module_from_spec(adapter_spec)
    adapter_spec.loader.exec_module(adapter)


class PanelProfileToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.node = self.root / "node"
        self.node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        self.node.chmod(0o755)
        self.app = self.root / "app"
        script = self.app / tool.CLI_RELATIVE_PATH
        script.parent.mkdir(parents=True)
        script.write_text("", encoding="utf-8")
        self.data = self.root / "data"
        self.data.mkdir()
        self.env = patch.dict(os.environ, {
            "PANEL_NODE": str(self.node),
            "PANEL_APP_ROOT": str(self.app),
            "PANEL_WORK_SESSION_ID": "caller-session",
            "PANEL_DATA_DIR": str(self.data),
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    @staticmethod
    def completed(payload, *, code=0, stderr=""):
        return tool.subprocess.CompletedProcess(
            args=[], returncode=code, stdout=json.dumps(payload) + "\n", stderr=stderr,
        )

    def invoke(self, args, payload, *, code=0, stderr=""):
        with patch.object(tool.subprocess, "run", return_value=self.completed(payload, code=code, stderr=stderr)) as run:
            result = json.loads(tool.panel_agents_tool(args))
        return result, run

    def test_runtime_requires_explicit_absolute_app_and_caller_paths(self):
        self.assertTrue(tool.panel_agents_available())
        with patch.dict(os.environ, {"PANEL_WORK_SESSION_ID": ""}):
            self.assertFalse(tool.panel_agents_available())
        with patch.dict(os.environ, {"PANEL_NODE": "node"}):
            self.assertFalse(tool.panel_agents_available())

    def test_list_returns_only_bounded_profile_summary(self):
        result, run = self.invoke({"action": "list"}, {
            "ok": True,
            "agents": [{
                "id": "researcher_1", "name": "Researcher", "provider": "openai",
                "model": "model-x", "description": "Find and compare evidence.",
                "working": True, "soul": "private instructions", "workingDirectory": "/secret",
            }],
        })
        self.assertEqual(result, {
            "ok": True,
            "agents": [{
                "id": "researcher_1", "name": "Researcher", "provider": "openai",
                "model": "model-x", "role": "Find and compare evidence.", "working": True,
                "working_directory": "/secret",
                "capabilities": {"mode": "unrestricted"},
            }],
        })
        args, kwargs = run.call_args
        self.assertEqual(args[0], [str(self.node), str((self.app / tool.CLI_RELATIVE_PATH).resolve())])
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["timeout"], 20)
        self.assertEqual(kwargs["env"]["PANEL_WORK_SESSION_ID"], "caller-session")
        self.assertEqual(kwargs["env"]["PANEL_DATA_DIR"], str(self.data))

    def test_list_distinguishes_explicit_empty_and_selected_capabilities(self):
        payload = {
            "ok": True,
            "agents": [
                {
                    "id": "empty", "name": "Empty", "capabilityPolicy": {
                        "version": 1,
                        "tools": {"mode": "allow", "ids": []},
                        "skills": {"mode": "allow", "ids": []},
                    },
                },
                {
                    "id": "reader", "name": "Reader", "capabilityPolicy": {
                        "version": 1,
                        "tools": {"mode": "allow", "ids": ["web_extract", "read_file"]},
                        "skills": {"mode": "allow", "ids": ["research"]},
                    },
                },
            ],
        }
        result, _ = self.invoke({"action": "list"}, payload)
        self.assertEqual(result["agents"][0]["capabilities"], {"mode": "explicit", "tools": [], "skills": []})
        self.assertEqual(result["agents"][1]["capabilities"], {
            "mode": "explicit", "tools": ["read_file", "web_extract"], "skills": ["research"],
        })

    def test_list_fails_closed_on_malformed_capability_policy(self):
        result, _ = self.invoke({"action": "list"}, {
            "ok": True,
            "agents": [{
                "id": "broken", "name": "Broken", "capabilityPolicy": {
                    "version": 1,
                    "tools": {"mode": "allow", "ids": ["bad/id"]},
                    "skills": {"mode": "allow", "ids": []},
                },
            }],
        })
        self.assertEqual(result["agents"][0]["capabilities"], {"mode": "unavailable"})

        normalized, _ = self.invoke({"action": "list"}, {
            "ok": True,
            "agents": [{
                "id": "stored-broken", "name": "Stored broken",
                "capabilityPolicy": {
                    "version": 1,
                    "tools": {"mode": "allow", "ids": []},
                    "skills": {"mode": "allow", "ids": []},
                },
                "capabilityPolicyUnavailable": True,
            }],
        })
        self.assertEqual(normalized["agents"][0]["capabilities"], {"mode": "unavailable"})

        missing_policy, _ = self.invoke({"action": "list"}, {
            "ok": True,
            "agents": [{
                "id": "stored-unreadable", "name": "Stored unreadable",
                "capabilityPolicy": None, "capabilityPolicyUnavailable": True,
            }],
        })
        self.assertEqual(missing_policy["agents"][0]["capabilities"], {"mode": "unavailable"})

    def test_run_returns_accepted_profile_session_and_run_ids(self):
        result, _ = self.invoke(
            {"action": "run", "agent_id": "researcher_1", "task": "Review this independent question."},
            {"ok": True, "agentId": "researcher_1", "sessionId": "profile-session", "run": {
                "id": "run-123", "state": "queued", "statusLabel": "Starting…",
            }},
        )
        self.assertEqual(result["accepted"], True)
        self.assertEqual(result["session_id"], "profile-session")
        self.assertEqual(result["run_id"], "run-123")
        self.assertEqual(result["status"], "queued")

    def test_create_defaults_to_no_capabilities_and_returns_a_bounded_profile(self):
        result, run = self.invoke(
            {"action": "create", "name": "Researcher", "role": "Trace claims to sources.", "idempotency_key": "request-42"},
            {"ok": True, "agent": {
                "id": "created-abc", "name": "Researcher", "description": "Trace claims to sources.",
                "sessionId": "profile-session", "capabilityPolicy": {
                    "version": 1, "tools": {"mode": "allow", "ids": []}, "skills": {"mode": "allow", "ids": []},
                },
            }},
        )
        self.assertEqual(result, {"ok": True, "created": True, "agent_id": "created-abc", "session_id": "profile-session", "name": "Researcher", "role": "Trace claims to sources.", "working_directory": "", "tools": 0, "skills": 0})
        request = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(request["tools"], [])
        self.assertEqual(request["skills"], [])

        with patch.object(tool.subprocess, "run") as blocked:
            invalid = json.loads(tool.panel_agents_tool({"action": "create", "name": "Unsafe", "role": "Escalate.", "idempotency_key": "bad", "tools": ["delegate_task"]}))
        self.assertFalse(invalid["ok"])
        blocked.assert_not_called()
        for field in ("tools", "skills"):
            with patch.object(tool.subprocess, "run") as blocked:
                malformed = json.loads(tool.panel_agents_tool({"action": "create", "name": "Malformed", "role": "Stay bounded.", "idempotency_key": "bad-shape", field: [{}]}))
            self.assertFalse(malformed["ok"])
            blocked.assert_not_called()

    def test_create_forwards_only_an_absolute_working_directory(self):
        result, run = self.invoke(
            {"action": "create", "name": "Reader", "role": "Read sources.", "idempotency_key": "reader-folder", "working_directory": str(self.root)},
            {"ok": True, "agent": {
                "id": "created-reader", "name": "Reader", "description": "Read sources.",
                "workingDirectory": str(self.root), "sessionId": "reader-session", "capabilityPolicy": {
                    "version": 1, "tools": {"mode": "allow", "ids": []}, "skills": {"mode": "allow", "ids": []},
                },
            }},
        )
        self.assertEqual(result["working_directory"], str(self.root))
        self.assertEqual(json.loads(run.call_args.kwargs["input"])["working_directory"], str(self.root))
        for value in ("relative", "", "\0bad"):
            with patch.object(tool.subprocess, "run") as blocked:
                invalid = json.loads(tool.panel_agents_tool({"action": "create", "name": "Reader", "role": "Read sources.", "idempotency_key": "bad-folder", "working_directory": value}))
            self.assertFalse(invalid["ok"])
            blocked.assert_not_called()

    def test_schema_requires_independent_scoped_work_and_terminal_result_collection(self):
        description = tool.TOOL_SCHEMA["description"]
        task_description = tool.TOOL_SCHEMA["parameters"]["properties"]["task"]["description"]
        self.assertIn("beneficial, independent work", description)
        self.assertIn("non-overlapping scope", description)
        self.assertIn("accepted, not completed", description)
        self.assertIn("terminal state", description)
        self.assertIn("verification", task_description)
        self.assertIn("non-overlapping scope", task_description)
        self.assertIn("Required for run, status, and stop", tool.TOOL_SCHEMA["parameters"]["properties"]["agent_id"]["description"])
        self.assertIn("Required for status and stop", tool.TOOL_SCHEMA["parameters"]["properties"]["run_id"]["description"])

    def test_status_and_stop_return_bounded_public_result_only(self):
        payload = {"ok": True, "agentId": "researcher_1", "sessionId": "profile-session", "statusWait": {
            "terminal": True, "timedOut": False, "waitedMs": 842, "observedAt": "2026-10-21T21:20:58.205Z", "automaticDelivery": False,
        }, "run": {
            "id": "run-123", "state": "complete", "statusLabel": "Finished",
            "response": "A concise verified result.", "error": "", "executionActive": False,
            "executionCancelRequestedAt": None, "permission": {"requestId": "private"},
            "textOnly": True,
        }}
        status, _ = self.invoke({"action": "status", "agent_id": "researcher_1", "run_id": "run-123"}, payload)
        self.assertEqual(status["result"], "A concise verified result.")
        self.assertTrue(status["terminal"])
        self.assertFalse(status["wait_timed_out"])
        self.assertEqual(status["waited_ms"], 842)
        self.assertFalse(status["automatic_delivery"])
        self.assertNotIn("permission", status)
        self.assertNotIn("textOnly", status)
        stop_payload = {**payload, "run": {**payload["run"], "state": "cancelled", "executionCancelRequestedAt": "now"}}
        stopped, _ = self.invoke({"action": "stop", "agent_id": "researcher_1", "run_id": "run-123"}, stop_payload)
        self.assertTrue(stopped["stop_requested"])

    def test_validation_rejects_unknown_profiles_invalid_actions_and_oversize_tasks(self):
        for args in (
            {"action": "run", "agent_id": "../outside", "task": "Do work"},
            {"action": "status", "agent_id": "agent", "run_id": "bad/id"},
            {"action": "delete"},
            {"action": "run", "agent_id": "agent", "task": "x" * (tool.MAX_TASK_CHARS + 1)},
            {"action": "list", "extra": "field"},
        ):
            with patch.object(tool.subprocess, "run") as run:
                result = json.loads(tool.panel_agents_tool(args))
            self.assertFalse(result["ok"])
            run.assert_not_called()

    def test_cli_timeout_is_honest_and_does_not_return_stderr(self):
        with patch.object(tool.subprocess, "run", side_effect=tool.subprocess.TimeoutExpired("node", 20, stderr="secret")):
            result = json.loads(tool.panel_agents_tool({"action": "run", "agent_id": "agent", "task": "Do work"}))
        self.assertFalse(result["ok"])
        self.assertIn("check the agent's status", result["error"])
        self.assertNotIn("secret", repr(result))

    def test_invalid_cli_responses_fail_closed_without_stderr_or_partial_data(self):
        with patch.object(tool.subprocess, "run", return_value=tool.subprocess.CompletedProcess([], 0, "not json\n", "secret")):
            invalid = json.loads(tool.panel_agents_tool({"action": "list"}))
        self.assertEqual(invalid, {"ok": False, "error": "Panel returned an invalid agent response."})
        with patch.object(tool.subprocess, "run", return_value=tool.subprocess.CompletedProcess([], 0, "x" * (tool.MAX_CLI_OUTPUT_CHARS + 1), "secret")):
            oversized = json.loads(tool.panel_agents_tool({"action": "list"}))
        self.assertFalse(oversized["ok"])
        self.assertNotIn("secret", repr(oversized))

    @unittest.skipUnless(HERMES_AVAILABLE, "installed Hermes runtime is not present")
    def test_registers_adapter_tool_without_replacing_an_existing_tool(self):
        from tools.registry import registry

        existing = registry.get_entry(tool.TOOL_NAME)
        if existing is not None:
            self.skipTest("panel_agents name is already registered in this test interpreter")
        self.assertTrue(tool.register_panel_agents_tool())
        entry = registry.get_entry(tool.TOOL_NAME)
        self.assertEqual(entry.toolset, "panel_agents")
        self.assertIs(entry.handler, tool.panel_agents_tool)
        self.assertIn(tool.TOOL_NAME, registry.get_tool_names_for_toolset("panel_agents"))
        from toolsets import resolve_toolset

        resolved = resolve_toolset("panel_agents")
        self.assertIn(tool.TOOL_NAME, resolved)
        definitions = registry.get_definitions(resolved, quiet=True)
        self.assertEqual(definitions[0]["function"]["name"], tool.TOOL_NAME)

    @unittest.skipUnless(HERMES_AVAILABLE, "installed Hermes runtime is not present")
    def test_control_adapter_adds_only_the_registered_profile_toolset(self):
        agent = type("Agent", (), {"model": ""})()
        manager = adapter.ControlSessionManager()
        with patch.object(adapter, "load_config", return_value={"agent": {}}), patch.object(
            adapter, "_get_platform_tools", return_value={"terminal"}
        ), patch.object(adapter, "enabled_mcp_server_names", return_value=set()), patch.object(
            adapter, "_expand_acp_enabled_toolsets", side_effect=lambda names, _mcp: names
        ), patch.object(adapter, "register_panel_agents_tool", return_value=True), patch.object(
            adapter, "panel_agents_available", return_value=True
        ), patch.object(adapter.SessionManager, "_make_agent", return_value=agent) as native_build:
            manager._make_agent(session_id="native", cwd="/tmp")
        self.assertIn("panel_agents", native_build.call_args.kwargs["enabled_toolsets"])

        with patch.object(adapter, "load_config", return_value={"agent": {"disabled_toolsets": ["panel_agents"]}}), patch.object(
            adapter, "_get_platform_tools", return_value={"terminal"}
        ), patch.object(adapter, "enabled_mcp_server_names", return_value=set()), patch.object(
            adapter, "_expand_acp_enabled_toolsets", side_effect=lambda names, _mcp: names
        ), patch.object(adapter, "register_panel_agents_tool", return_value=True), patch.object(
            adapter, "panel_agents_available", return_value=True
        ), patch.object(adapter.SessionManager, "_make_agent", return_value=agent) as native_build:
            manager._make_agent(session_id="native", cwd="/tmp")
        self.assertNotIn("panel_agents", native_build.call_args.kwargs["enabled_toolsets"])

    @unittest.skipUnless(HERMES_AVAILABLE, "installed Hermes runtime is not present")
    def test_planning_only_adapter_has_no_tools_or_toolsets(self):
        agent = type("Agent", (), {
            "model": "", "tools": ["terminal"], "valid_tool_names": {"terminal"},
            "enabled_toolsets": ["terminal"],
        })()
        manager = adapter.ControlSessionManager()
        with patch.dict(os.environ, {"PANEL_DISABLE_TOOLS": "1"}), patch.object(
            adapter, "load_config", return_value={"agent": {}}
        ), patch.object(adapter, "_get_platform_tools", return_value={"terminal"}), patch.object(
            adapter, "enabled_mcp_server_names", return_value=set()
        ), patch.object(
            adapter, "_expand_acp_enabled_toolsets", side_effect=lambda names, _mcp: names
        ), patch.object(adapter.SessionManager, "_make_agent", return_value=agent) as native_build:
            result = manager._make_agent(session_id="planning", cwd="/tmp")
        self.assertEqual(native_build.call_args.kwargs["enabled_toolsets"], [])
        self.assertEqual(result.tools, [])
        self.assertEqual(result.valid_tool_names, set())
        self.assertEqual(result.enabled_toolsets, [])


if __name__ == "__main__":
    unittest.main()
