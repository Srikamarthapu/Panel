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
HERMES_REPO = Path.home() / ".hermes/hermes-agent"
os.environ.setdefault("HERMES_REPO", str(HERMES_REPO))
if HERMES_REPO.is_dir():
    sys.path.insert(0, str(HERMES_REPO))
sys.path.insert(0, str(REPO / "scripts/voice"))
import panel_profile_tools as tool

adapter_path = REPO / "scripts/voice/panel-acp.py"
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
            }],
        })
        args, kwargs = run.call_args
        self.assertEqual(args[0], [str(self.node), str((self.app / tool.CLI_RELATIVE_PATH).resolve())])
        self.assertFalse(kwargs["shell"])
        self.assertEqual(kwargs["timeout"], 15)
        self.assertEqual(kwargs["env"]["PANEL_WORK_SESSION_ID"], "caller-session")
        self.assertEqual(kwargs["env"]["PANEL_DATA_DIR"], str(self.data))

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

    def test_status_and_stop_return_bounded_public_result_only(self):
        payload = {"ok": True, "agentId": "researcher_1", "sessionId": "profile-session", "run": {
            "id": "run-123", "state": "complete", "statusLabel": "Finished",
            "response": "A concise verified result.", "error": "", "executionActive": False,
            "executionCancelRequestedAt": None, "permission": {"requestId": "private"},
            "textOnly": True,
        }}
        status, _ = self.invoke({"action": "status", "agent_id": "researcher_1", "run_id": "run-123"}, payload)
        self.assertEqual(status["result"], "A concise verified result.")
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
        with patch.object(tool.subprocess, "run", side_effect=tool.subprocess.TimeoutExpired("node", 15, stderr="secret")):
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

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
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

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
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

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
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
