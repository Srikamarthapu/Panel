import builtins
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
LAUNCHER_PATH = REPO / "scripts/voice/launch-panel-acp.py"
SPEC = importlib.util.spec_from_file_location("panel_acp_launcher", LAUNCHER_PATH)
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


class PanelACPLauncherTests(unittest.TestCase):
    def test_uses_hermes_runtime_command_when_pm_is_available(self):
        repo = Path("/fake/hermes")
        calls = []

        def runtime_command(root, *, code):
            calls.append((root, code))
            return ["/managed/python", "-I", "-c", code]

        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        launchers = types.ModuleType("hermes_cli._launchers")
        launchers.runtime_command = runtime_command
        original_path = list(sys.path)
        try:
            with mock.patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli._launchers": launchers}):
                command = launcher._runtime_command(repo, "import runpy")
        finally:
            sys.path[:] = original_path

        self.assertEqual(command[:2], ["/managed/python", "-I"])
        self.assertEqual(calls, [(repo, "import runpy")])

    def test_uses_legacy_python_only_when_pm_is_absent(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            original_path = list(sys.path)

            def missing_pm(name, globals=None, locals=None, fromlist=(), level=0):
                if name == "hermes_cli._launchers":
                    raise ModuleNotFoundError("PM is unavailable", name="pm")
                return real_import(name, globals, locals, fromlist, level)

            real_import = builtins.__import__
            try:
                with mock.patch("builtins.__import__", side_effect=missing_pm):
                    command = launcher._runtime_command(repo, "import runpy")
            finally:
                sys.path[:] = original_path

        self.assertEqual(command[:2], [sys.executable, "-c"])
        self.assertIn("sys.path.insert", command[2])
        self.assertIn("import runpy", command[2])

    def test_does_not_hide_broken_pm_or_missing_dependencies_as_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "pm").mkdir()
            original_path = list(sys.path)

            def missing_dependency(name, globals=None, locals=None, fromlist=(), level=0):
                if name == "hermes_cli._launchers":
                    raise ModuleNotFoundError("dependency is missing", name="ruamel")
                return real_import(name, globals, locals, fromlist, level)

            real_import = builtins.__import__
            try:
                with mock.patch("builtins.__import__", side_effect=missing_dependency):
                    with self.assertRaisesRegex(ModuleNotFoundError, "dependency is missing"):
                        launcher._runtime_command(repo, "import runpy")
            finally:
                sys.path[:] = original_path

    def test_disables_lazy_installs_before_resolving_and_execing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = []

            def resolve(repo, code):
                calls.append((repo, code, os.environ.get("HERMES_DISABLE_LAZY_INSTALLS")))
                return ["/managed/python", "-I"]

            with mock.patch.dict(os.environ, {"HERMES_REPO": directory}, clear=False):
                with mock.patch.object(launcher, "_runtime_command", side_effect=resolve):
                    with mock.patch.object(launcher, "os") as os_module:
                        os_module.environ = os.environ
                        os_module.execv.side_effect = SystemExit
                        with mock.patch.object(sys, "argv", [str(LAUNCHER_PATH), "--check"]):
                            with self.assertRaises(SystemExit):
                                launcher._main()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][2], "1")
        self.assertIn("ControlACPAgent", calls[0][1])


if __name__ == "__main__":
    unittest.main()
