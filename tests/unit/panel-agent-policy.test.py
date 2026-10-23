"""Focused tests for saved-agent capability enforcement inside Hermes."""

import json
import os
from pathlib import Path
import sys
import unittest


REPO = Path(__file__).resolve().parents[2]
HERMES_REPO = Path(os.environ.get("HERMES_REPO", str(Path.home() / ".hermes/hermes-agent")))
HERMES_AVAILABLE = (HERMES_REPO / "hermes_cli").is_dir()
os.environ["HERMES_REPO"] = str(HERMES_REPO)
if HERMES_AVAILABLE:
    sys.path.insert(0, str(HERMES_REPO))
sys.path.insert(0, str(REPO / "scripts/voice"))

import panel_agent_policy as policy


class PanelAgentPolicyTests(unittest.TestCase):
    def test_missing_is_legacy_and_explicit_empty_means_none(self):
        self.assertIsNone(policy.load_panel_agent_policy(""))
        parsed = policy.load_panel_agent_policy(json.dumps({
            "version": 1,
            "tools": {"mode": "allow", "ids": []},
            "skills": {"mode": "allow", "ids": []},
        }))
        self.assertEqual(policy.allowed_tool_names(parsed), frozenset())

    def test_unknown_and_delegation_tools_fail_closed(self):
        for tool_name in ("unknown_tool", "delegate_task", "panel_agents", "cronjob_manage"):
            with self.assertRaises(policy.PanelPolicyError):
                policy.load_panel_agent_policy(json.dumps({
                    "version": 1,
                    "tools": {"mode": "allow", "ids": [tool_name]},
                    "skills": {"mode": "allow", "ids": []},
                }))

    def test_skills_add_only_the_bounded_read_tools(self):
        parsed = policy.load_panel_agent_policy(json.dumps({
            "version": 1,
            "tools": {"mode": "allow", "ids": ["web_search"]},
            "skills": {"mode": "allow", "ids": ["one-skill"]},
        }))
        self.assertEqual(policy.allowed_tool_names(parsed), frozenset({"web_search", "skills_list", "skill_view"}))

    @unittest.skipUnless(HERMES_AVAILABLE, "installed Hermes runtime is not present")
    def test_schema_and_direct_execution_paths_are_both_filtered(self):
        parsed = policy.load_panel_agent_policy(json.dumps({
            "version": 1,
            "tools": {"mode": "allow", "ids": []},
            "skills": {"mode": "allow", "ids": []},
        }))
        agent = type("Agent", (), {
            "tools": [
                {"function": {"name": "terminal"}},
                {"function": {"name": "panel_agents"}},
                {"function": {"name": "skills_list"}},
            ],
            "valid_tool_names": {"terminal", "panel_agents", "skills_list"},
            "enabled_toolsets": ["all"],
        })()
        policy.install_runtime_enforcement(agent, parsed)
        self.assertEqual(agent.tools, [])
        self.assertEqual(agent.valid_tool_names, set())

        import model_tools
        from tools import skills_tool
        from tools.registry import registry

        self.assertIn("not allowed", model_tools.handle_function_call("panel_agents", {}))
        self.assertIn("not allowed", registry.dispatch("panel_agents", {}))
        listed = json.loads(skills_tool.skills_list())
        self.assertEqual(listed["skills"], [])


if __name__ == "__main__":
    unittest.main()
