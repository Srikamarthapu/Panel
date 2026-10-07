"""Tests use Hermes' prompt helpers locally and never call a provider."""

import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
HERMES_REPO = Path.home() / ".hermes/hermes-agent"
os.environ.setdefault("HERMES_REPO", str(HERMES_REPO))
if HERMES_REPO.is_dir():
    sys.path.insert(0, str(HERMES_REPO))
sys.path.insert(0, str(REPO / "scripts/voice"))

import panel_profile_identity as identity

adapter_path = REPO / "scripts/voice/panel-acp.py"
adapter_spec = importlib.util.spec_from_file_location("panel_profile_identity_adapter", adapter_path)
adapter = importlib.util.module_from_spec(adapter_spec)
adapter_spec.loader.exec_module(adapter)


class PanelProfileIdentityTests(unittest.TestCase):
    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
    def test_native_identity_slot_is_overridden_per_agent_and_other_agents_stay_native(self):
        import agent.system_prompt as system_prompt

        self.assertTrue(identity.install_panel_identity_override())
        self.assertTrue(identity.install_panel_identity_override())
        ordinary = SimpleNamespace(load_soul_identity=False, skip_context_files=True)
        profile_a = SimpleNamespace(_panel_profile_soul="# Researcher\nFind evidence.")
        profile_b = SimpleNamespace(_panel_profile_soul="# Builder\nShip reliable code.")

        ordinary_parts, _ = system_prompt._identity_parts(ordinary, None)
        a_parts, a_loaded = system_prompt._identity_parts(profile_a, None)
        b_parts, b_loaded = system_prompt._identity_parts(profile_b, None)
        self.assertNotIn("# Researcher", ordinary_parts[0])
        self.assertEqual(a_parts, ["# Researcher\nFind evidence."])
        self.assertEqual(b_parts, ["# Builder\nShip reliable code."])
        self.assertTrue(a_loaded)
        self.assertTrue(b_loaded)

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
    def test_profile_change_invalidates_only_that_native_session_prompt_cache(self):
        class SessionDB:
            def __init__(self):
                self.cleared = []

            def update_system_prompt(self, session_id, value):
                self.cleared.append((session_id, value))

        db = SessionDB()
        agent = SimpleNamespace(
            session_id="native-profile-session",
            _session_db=db,
            _cached_system_prompt="ambient identity prompt",
            _cached_system_prompt_static="ambient identity prefix",
            _static_rebuild_failed_for="old prompt",
            load_soul_identity=False,
            _plugin_system_prompt_sections_snapshot=("old plugin bytes",),
        )
        self.assertTrue(identity.apply_panel_profile_identity(agent, "# Analyst\nUse evidence."))
        self.assertEqual(agent._panel_profile_soul, "# Analyst\nUse evidence.")
        self.assertTrue(agent.load_soul_identity)
        self.assertIsNone(agent._cached_system_prompt)
        self.assertIsNone(agent._cached_system_prompt_static)
        self.assertIsNone(agent._static_rebuild_failed_for)
        self.assertFalse(hasattr(agent, "_plugin_system_prompt_sections_snapshot"))
        self.assertEqual(db.cleared, [("native-profile-session", None)])

        # Loading the same profile again preserves the native cache; changing
        # the profile identity clears just this session's stored prompt again.
        self.assertTrue(identity.apply_panel_profile_identity(agent, "# Analyst\nUse evidence."))
        self.assertEqual(len(db.cleared), 1)
        agent._cached_system_prompt = "profile A prompt"
        self.assertTrue(identity.apply_panel_profile_identity(agent, "# Reviewer\nCheck edge cases."))
        self.assertIsNone(agent._cached_system_prompt)
        self.assertEqual(db.cleared, [("native-profile-session", None), ("native-profile-session", None)])

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
    def test_profile_identity_uses_native_soul_safety_and_context_truncation(self):
        import agent.system_prompt as system_prompt
        import agent.prompt_builder as prompt_builder

        identity.install_panel_identity_override()
        calls = []

        def scan(content, filename, *, user_authored=False):
            calls.append((filename, user_authored))
            return content.strip()

        def truncate(content, filename, **kwargs):
            calls.append((filename, kwargs.get("read_path")))
            return content[:5]

        with patch.object(prompt_builder, "_scan_context_content", side_effect=scan), patch.object(
            prompt_builder, "_truncate_content", side_effect=truncate,
        ):
            parts, loaded = system_prompt._identity_parts(
                SimpleNamespace(_panel_profile_soul="# Long identity", _panel_profile_soul_path="/private/SOUL.md"),
                8192,
            )
        self.assertEqual(parts, ["# Lon"])
        self.assertTrue(loaded)
        self.assertEqual(calls, [("SOUL.md", True), ("SOUL.md", "/private/SOUL.md")])

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
    def test_normal_prompt_builder_uses_profile_soul_in_stable_and_cached_prefix(self):
        import agent.system_prompt as system_prompt

        identity.install_panel_identity_override()
        agent = SimpleNamespace(
            _panel_profile_soul="# Analyst\nUse evidence from the task.",
            _panel_profile_soul_path="/private/agents/analyst/SOUL.md",
            context_compressor=None,
            valid_tool_names=set(),
            _memory_store=None,
            _memory_enabled=False,
            _user_profile_enabled=False,
            _memory_manager=None,
            _emit_diagnostic_status=lambda _message: None,
        )
        with patch.object(system_prompt, "_guidance_parts", return_value=[]), patch.object(
            system_prompt, "_skills_prompt", return_value=""
        ), patch.object(system_prompt, "_coding_parts", return_value=([], [], [])), patch.object(
            system_prompt, "_post_workspace_parts", return_value=[]
        ), patch.object(system_prompt, "_context_files_part", return_value=[]), patch.object(
            system_prompt, "_alibaba_identity_part", return_value=[]
        ), patch.object(system_prompt, "_auto_load_parts", return_value=[]), patch.object(
            system_prompt, "_memory_parts", return_value=[]
        ), patch.object(system_prompt, "_frozen_plugin_prompt_sections", return_value=()), patch.object(
            system_prompt, "_plugin_section_blocks", return_value=[]
        ), patch.object(system_prompt, "_timestamp_line", return_value=""), patch.object(
            system_prompt._pb, "build_environment_hints", return_value=""
        ):
            prompt = system_prompt.build_system_prompt(agent, system_message="")

        self.assertTrue(prompt.startswith("# Analyst\nUse evidence from the task."))
        self.assertTrue(agent._cached_system_prompt_static.startswith("# Analyst\nUse evidence from the task."))
        self.assertNotIn("ambient Hermes", prompt)

    def test_invalid_or_missing_profile_identity_does_not_install(self):
        agent = SimpleNamespace(session_id="native-session")
        self.assertFalse(identity.apply_panel_profile_identity(agent, ""))
        self.assertFalse(identity.apply_panel_profile_identity(agent, "x" * (identity._PROFILE_SOUL_MAX_CHARS + 1)))

    @unittest.skipUnless(HERMES_REPO.is_dir(), "installed Hermes runtime is not present")
    def test_cache_clear_failure_fails_closed_and_can_retry(self):
        class BrokenDB:
            def update_system_prompt(self, *_args):
                raise OSError("unavailable")

        agent = SimpleNamespace(session_id="native-profile-session", _session_db=BrokenDB())
        with self.assertLogs(identity.logger, level="WARNING"):
            self.assertFalse(identity.apply_panel_profile_identity(agent, "# Analyst\nUse evidence."))
        self.assertIsNone(agent._panel_profile_soul_digest)


class ACPProfileIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_and_loaded_profile_sessions_receive_the_native_primary_soul(self):
        class SessionDB:
            def __init__(self):
                self.clears = []

            def update_system_prompt(self, session_id, value):
                self.clears.append((session_id, value))

        dbs = [SessionDB(), SessionDB()]
        agents = [
            SimpleNamespace(session_id="new-native", _session_db=dbs[0], _cached_system_prompt="old ambient prompt"),
            SimpleNamespace(session_id="loaded-native", _session_db=dbs[1], _cached_system_prompt="old ambient prompt"),
        ]
        states = {agent.session_id: SimpleNamespace(agent=agent) for agent in agents}
        control = adapter.ControlACPAgent()
        control.session_manager = SimpleNamespace(get_session=lambda session_id: states.get(session_id))
        observed = []

        async def base_prompt(self, prompt, session_id, **kwargs):
            agent = states[session_id].agent
            observed.append((session_id, agent._panel_profile_soul, agent._cached_system_prompt))
            return "completed"

        with patch.dict(os.environ, {
            "PANEL_AGENT_SOUL": "# Researcher\nUse evidence and report uncertainty.",
            "PANEL_ACP_INSTRUCTIONS": "Shared Control rules.",
        }), patch.object(adapter.server.HermesACPAgent, "prompt", base_prompt):
            for session_id in states:
                result = await control.prompt([], session_id, **{"hermes-control/run-id": f"run-{session_id}"})
                self.assertEqual(result, "completed")

        self.assertEqual([item[1] for item in observed], ["# Researcher\nUse evidence and report uncertainty."] * 2)
        self.assertTrue(all(item[2] is None for item in observed))
        self.assertEqual([db.clears for db in dbs], [[("new-native", None)], [("loaded-native", None)]])


if __name__ == "__main__":
    unittest.main()
