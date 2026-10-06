#!/usr/bin/env python3
"""Install the narrow Hermes gateway hook used by Jev's Discord model router.

This is an idempotent patch for the local Hermes checkout. It adds one plugin
hook before AIAgent construction and keeps model/provider/session authority in
Hermes. --uninstall removes only the exact inserted blocks. Neither operation
changes configuration or restarts the gateway.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import tempfile
import textwrap


HOOK_MARKER = '    "pre_model_route",'
HOOK_ANCHOR = '    "pre_gateway_dispatch",'
HOOK_INSERT = '''    # pre_model_route: Discord turn, after session model resolution and before AIAgent
    # construction. A plugin may return {"model": one of candidates, "provider": provider};
    # the gateway validates both and preserves explicit /model overrides.
    "pre_model_route",
'''

HELPER_MARKER = "def _route_discord_turn_model("
HELPER_ANCHOR = "def _renders_exec_approval_buttons(adapter_cls: type) -> bool:"
HELPER_INSERT = textwrap.dedent('''\
def _route_discord_turn_model(runner, ctx: TurnContext, model: str, runtime_kwargs: dict) -> str:
    """Ask plugins to choose from the resolved model and same-provider fallbacks."""
    if ctx.source.platform != Platform.DISCORD or not ctx.session_key:
        return model
    # A user-selected /model (including --once) is authoritative for this session.
    if runner._session_model_override(ctx.session_key) is not None:
        return model
    provider = str(runtime_kwargs.get("provider") or "").strip()
    if not provider or not model:
        return model
    # Some Hermes providers derive their API mode from the selected model (for
    # example Copilot, OpenCode, and Nous). This hook only changes the model ID,
    # so keep those choices only when the derived wire format matches the
    # already-resolved runtime. Older hosts without this helper fail closed.
    try:
        from hermes_cli.model_switch import model_derived_api_mode
        active_api_mode = str(runtime_kwargs.get("api_mode") or "").strip().lower()
        derived_api_mode = model_derived_api_mode(provider, model, runtime_kwargs.get("api_key") or "")
        if derived_api_mode and derived_api_mode.strip().lower() != active_api_mode:
            return model
    except Exception:
        return model
    candidates = [model]
    try:
        for entry in runner._refresh_fallback_model() or []:
            if not isinstance(entry, dict) or str(entry.get("provider") or "").strip().lower() != provider.lower():
                continue
            # The hook changes only the model ID. Do not route a fallback that
            # needs its own credentials, endpoint, API mode, or request overrides.
            if any(entry.get(key) for key in (
                "api_key", "api_key_env", "key_env", "extra_headers", "extra_body",
                "reasoning_effort", "temperature", "max_tokens", "top_p",
            )):
                continue
            fallback_base = str(entry.get("base_url") or "").strip().rstrip("/").lower()
            active_base = str(runtime_kwargs.get("base_url") or "").strip().rstrip("/").lower()
            if fallback_base and fallback_base != active_base:
                continue
            fallback_mode = str(entry.get("api_mode") or "").strip().lower()
            if fallback_mode and fallback_mode != active_api_mode:
                continue
            candidate = str(entry.get("model") or "").strip()
            candidate_api_mode = model_derived_api_mode(provider, candidate, runtime_kwargs.get("api_key") or "")
            if candidate_api_mode and candidate_api_mode.strip().lower() != active_api_mode:
                continue
            if candidate and candidate not in candidates:
                candidates.append(candidate)
                if len(candidates) >= 4:
                    break
        if len(candidates) < 2:
            return model
        from hermes_cli.plugins import has_hook, invoke_hook
        if not has_hook("pre_model_route"):
            return model
        for result in invoke_hook(
            "pre_model_route", platform="discord", session_id=ctx.session_id,
            session_key=ctx.session_key, user_message=ctx.message,
            model=model, provider=provider, candidates=list(candidates),
        ):
            if not isinstance(result, dict):
                continue
            selected = result.get("model")
            selected_provider = result.get("provider")
            if (isinstance(selected, str) and selected in candidates
                    and isinstance(selected_provider, str) and selected_provider.lower() == provider.lower()):
                if selected != model:
                    logger.info("pre_model_route selected %s for Discord session %s", selected, ctx.session_key)
                return selected
    except Exception:
        logger.warning("pre_model_route failed; using resolved model", exc_info=True)
    return model


def _evict_discord_cached_model_mismatch(runner, ctx: TurnContext, model: str) -> None:
    """Release the old agent before a different model replaces its cache entry."""
    if ctx.source.platform != Platform.DISCORD or not ctx.session_key:
        return
    cache = getattr(runner, "_agent_cache", None)
    if cache is None:
        return
    lock = getattr(runner, "_agent_cache_lock", None)
    if lock:
        with lock:
            cached = cache.get(ctx.session_key)
    else:
        cached = cache.get(ctx.session_key)
    cached_agent = cached[0] if isinstance(cached, tuple) and cached else None
    if cached_agent is not None and getattr(cached_agent, "model", model) != model:
        runner._evict_cached_agent(ctx.session_key)


''')

RUN_MARKER = "        model = _route_discord_turn_model(runner, ctx, model, runtime_kwargs)"
RUN_ANCHOR = "        pr = runner._provider_routing\n        reasoning_config = runner._resolve_session_reasoning_config(source=ctx.source, session_key=ctx.session_key, model=model)"
RUN_INSERT = """        model = _route_discord_turn_model(runner, ctx, model, runtime_kwargs)
        _evict_discord_cached_model_mismatch(runner, ctx, model)
"""


def insert_once(source: str, marker: str, anchor: str, insertion: str, *, before: bool) -> tuple[str, bool]:
    if marker in source:
        return source, False
    if source.count(anchor) != 1:
        raise RuntimeError(f"Expected exactly one patch anchor: {anchor[:80]}")
    replacement = insertion + anchor if before else anchor + "\n" + insertion.rstrip("\n")
    return source.replace(anchor, replacement, 1), True


def remove_once(source: str, marker: str, anchor: str, insertion: str) -> tuple[str, bool]:
    if marker not in source:
        return source, False
    installed = insertion + anchor
    if source.count(installed) != 1:
        raise RuntimeError(f"Installed block was edited; refusing to remove: {marker[:80]}")
    return source.replace(installed, anchor, 1), True


def atomic_write(path: Path, content: str) -> None:
    mode = path.stat().st_mode & 0o777
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate patch applicability without writing")
    parser.add_argument("--uninstall", action="store_true", help="Remove only this installer's exact code blocks")
    args = parser.parse_args()
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    repository = Path(os.environ.get("HERMES_REPO", home / "hermes-agent"))
    hook_file = repository / "hermes_cli" / "plugins.py"
    runner_file = repository / "gateway" / "run_turn_runner.py"
    originals = {path: path.read_text(encoding="utf-8") for path in (hook_file, runner_file)}
    changed = {}
    if args.uninstall:
        hooks, _ = remove_once(originals[hook_file], HOOK_MARKER, HOOK_ANCHOR, HOOK_INSERT)
        runner, _ = remove_once(originals[runner_file], RUN_MARKER, RUN_ANCHOR, RUN_INSERT)
        runner, _ = remove_once(runner, HELPER_MARKER, HELPER_ANCHOR, HELPER_INSERT)
    else:
        hooks, _ = insert_once(originals[hook_file], HOOK_MARKER, HOOK_ANCHOR, HOOK_INSERT, before=True)
        runner, _ = insert_once(originals[runner_file], HELPER_MARKER, HELPER_ANCHOR, HELPER_INSERT, before=True)
        runner, _ = insert_once(runner, RUN_MARKER, RUN_ANCHOR, RUN_INSERT, before=True)
    for path, content in ((hook_file, hooks), (runner_file, runner)):
        compile(content, str(path), "exec")
        if content != originals[path]:
            changed[path] = content
    if args.check:
        print("Patch validated; files needing update:", ", ".join(str(p) for p in changed) or "none")
        return
    for path, content in changed.items():
        atomic_write(path, content)
    if args.uninstall:
        print("Jev Discord model-route hook removed." if changed else "Jev Discord model-route hook is not installed.")
    else:
        print("Jev Discord model-route hook installed." if changed else "Jev Discord model-route hook already installed.")


if __name__ == "__main__":
    main()
