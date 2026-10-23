"""Run plain test_* functions through unittest without requiring pytest."""
import os
from pathlib import Path
import runpy
import sys
import unittest


if len(sys.argv) != 2:
    raise SystemExit("usage: test-host-functions.py TEST_FILE")
hermes_repo = Path(os.environ.get("HERMES_REPO", ""))
if not (hermes_repo / "hermes_cli").is_dir():
    raise SystemExit("HERMES_REPO must point to a compatible installed Hermes checkout")
sys.path.insert(0, str(hermes_repo))
namespace = runpy.run_path(sys.argv[1])
functions = [value for name, value in sorted(namespace.items()) if name.startswith("test_") and callable(value)]
if not functions:
    raise SystemExit(f"no test_* functions found in {sys.argv[1]}")
suite = unittest.TestSuite(unittest.FunctionTestCase(function) for function in functions)
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
