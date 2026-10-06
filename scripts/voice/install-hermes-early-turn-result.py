#!/usr/bin/env python3
"""Check native early-turn support without modifying the Hermes installation.

Kept at the old installer path for existing setup instructions. Modern Hermes
publishes a private, atomic turn report before background cleanup. Panel uses
that native contract; patching cli.py is no longer necessary or supported.
"""
import argparse
import ast
import json
import os
from pathlib import Path


def capabilities(repository):
    repository = Path(repository)
    files = {
        "report": repository / "hermes_cli" / "quiet_single_query.py",
        "runner": repository / "hermes_cli" / "cli_single_query.py",
        "stream": repository / "hermes_cli" / "stream_json.py",
    }
    try:
        source = {key: file.read_text() for key, file in files.items()}
        trees = {key: ast.parse(text) for key, text in source.items()}
    except (OSError, SyntaxError):
        return {"supported": False, "nativeTurnReport": False, "streamJson": False}
    functions = {node.name for node in ast.walk(trees["report"]) if isinstance(node, ast.FunctionDef)}
    report = {"take_turn_report_path", "write_turn_report"} <= functions and "HERMES_QUIET_TURN_REPORT_FILE" in source["report"] and "write_turn_report(" in source["runner"]
    stream = any(isinstance(node, ast.FunctionDef) and node.name == "emit_result" for node in ast.walk(trees["stream"]))
    return {"supported": report and stream, "nativeTurnReport": report, "streamJson": stream}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check compatibility (always read-only).")
    parser.add_argument("--json", action="store_true", help="Return a machine-readable capability report.")
    parser.add_argument("--repo", type=Path, default=Path(os.environ.get("HERMES_REPO") or Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "hermes-agent"))
    args = parser.parse_args()
    result = capabilities(args.repo)
    if args.json:
        print(json.dumps(result))
    elif result["supported"]:
        print("Native Hermes early-turn reports are available. No host patch is needed.")
    else:
        print("This Hermes installation lacks the supported native turn-report contract. Update Hermes and rerun this check. No files were changed.")
    return 0 if result["supported"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
