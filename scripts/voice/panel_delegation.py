"""Bridge native Hermes subagent lifecycle callbacks to Control's private ACP extension.

The installed runtime owns delegation execution and its live-child registry. This
module only projects a small, sanitized view of callbacks it already emits and
offers a parent-scoped stop helper for the ACP extension method.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import threading
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any, Callable


logger = logging.getLogger(__name__)

AGENT_UPDATE_METHOD = "panel/agent_update"
STOP_AGENT_METHOD = "panel/stop_agent"

_RUN_HISTORY_LIMIT = 96
_RUN_AGENT_LIMIT = 128
_PENDING_TERMINAL_LIMIT = _RUN_HISTORY_LIMIT * _RUN_AGENT_LIMIT
_TERMINAL_NOTIFICATION_TIMEOUT_SECONDS = 2.0
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.IGNORECASE | re.DOTALL,
)
_CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_COMMAND_LINE_RE = re.compile(
    r"(?im)^\s*(?:\$\s*|>\s*|PS>\s*|(?:sudo|curl|wget|git|npm|npx|pnpm|yarn|python\w*|node|bash|sh|zsh|export|cd)\s+).*$"
)
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|authorization)"
    r"\b\s*[:=]\s*[^\s,;]+"
)
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*")
_TOKEN_RE = re.compile(
    r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{16,}\b"
)
_URL_AUTH_RE = re.compile(r"(?i)\b(https?://)[^/@\s:]+:[^/@\s]+@")

_TERMINAL_STATUS = {
    "complete": "complete",
    "completed": "complete",
    "success": "complete",
    "failed": "error",
    "error": "error",
    "timeout": "error",
    "interrupted": "cancelled",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "stopped": "cancelled",
}

_run_agents_lock = threading.RLock()
# (native parent session, app run id) -> {subagent id -> last public state}.
# This map also scopes a stop request after the parent prompt has returned.
_run_agents: OrderedDict[tuple[str, str], OrderedDict[str, dict[str, Any]]] = OrderedDict()


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_ID_RE.fullmatch(value))


def _valid_session_id(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 200 and not _CONTROL_RE.search(value)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _bounded_count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return max(0, min(number, 1_000_000))


def _bounded_duration(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return round(min(number, 172_800), 1)


def sanitize_public_text(value: Any, *, limit: int = 360) -> str:
    """Keep a short display string while removing code, command lines and common credentials."""
    if not isinstance(value, str) or limit < 1:
        return ""
    text = unicodedata.normalize("NFKC", value)
    text = _ANSI_RE.sub("", text)
    text = _PRIVATE_KEY_RE.sub("[private key removed]", text)
    text = _CODE_BLOCK_RE.sub("[code removed]", text)
    text = _INLINE_CODE_RE.sub("[details removed]", text)
    text = _COMMAND_LINE_RE.sub("", text)
    text = _SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}=[redacted]", text)
    text = _BEARER_RE.sub("Bearer [redacted]", text)
    text = _TOKEN_RE.sub("[credential removed]", text)
    text = _URL_AUTH_RE.sub(r"\1[credentials removed]@", text)
    text = _CONTROL_RE.sub(" ", text)
    text = " ".join(text.split())
    return text[:limit].rstrip()


def _status_from_event(event_type: str, kwargs: dict[str, Any]) -> str | None:
    if event_type == "subagent.spawn_requested":
        return "queued"
    if event_type == "subagent.start":
        return "running"
    if event_type == "subagent.complete":
        return _TERMINAL_STATUS.get(str(kwargs.get("status") or "").strip().lower(), "error")
    if event_type == "subagent.tool":
        return "running"
    return None


def _remember(scope: tuple[str, str], agent_id: str, agent: dict[str, Any]) -> bool:
    """Update bounded run state. Late progress cannot reopen a terminal child."""
    with _run_agents_lock:
        agents = _run_agents.setdefault(scope, OrderedDict())
        prior = agents.get(agent_id)
        if prior and prior.get("status") in {"complete", "error", "cancelled"}:
            return False
        agents[agent_id] = dict(agent)
        agents.move_to_end(agent_id)
        while len(agents) > _RUN_AGENT_LIMIT:
            agents.popitem(last=False)
        _run_agents.move_to_end(scope)
        while len(_run_agents) > _RUN_HISTORY_LIMIT:
            _run_agents.popitem(last=False)
        return True


def _public_agent_update(event_type: Any, preview: Any, kwargs: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    if event_type not in {"subagent.spawn_requested", "subagent.start", "subagent.tool", "subagent.complete"}:
        # In particular, never forward _thinking, subagent.thinking, tool names,
        # command previews, tool arguments, or raw child output tails.
        return None

    agent_id = kwargs.get("subagent_id")
    if not _valid_id(agent_id):
        return None
    status = _status_from_event(event_type, kwargs)
    if status is None:
        return None

    task_value = kwargs.get("goal")
    if not isinstance(task_value, str) or not task_value.strip():
        task_value = preview if event_type in {"subagent.spawn_requested", "subagent.start"} else ""
    task = sanitize_public_text(task_value, limit=220)
    task_index = _bounded_count(kwargs.get("task_index"))
    name = task or (f"Agent {task_index + 1}" if task_index is not None else "Delegated agent")
    updated_at = _timestamp()
    agent: dict[str, Any] = {
        "id": agent_id,
        "name": name[:96],
        "task": task,
        "status": status,
        "updatedAt": updated_at,
    }

    parent_id = kwargs.get("parent_id")
    if _valid_id(parent_id):
        agent["parentId"] = parent_id
    child_session_id = kwargs.get("child_session_id")
    if _valid_session_id(child_session_id):
        agent["childSessionId"] = child_session_id
    delegation_id = kwargs.get("delegation_id")
    if _valid_id(delegation_id):
        agent["delegationId"] = delegation_id
    tool_count = _bounded_count(kwargs.get("tool_count"))
    if tool_count is not None:
        agent["toolCount"] = tool_count
    duration = _bounded_duration(kwargs.get("duration_seconds"))
    if duration is not None:
        agent["durationSeconds"] = duration

    if event_type == "subagent.start":
        agent["startedAt"] = updated_at
    elif event_type == "subagent.complete":
        summary = sanitize_public_text(kwargs.get("summary"), limit=420)
        if summary:
            agent["result"] = summary

    return agent_id, agent


def _can_stop_subagent(agent: Any, subagent_id: str, delegation_id: Any = None) -> bool:
    """Expose stop only when Hermes confirms a live child owned by this parent."""
    api = _delegation_control_api()
    if api is None:
        return False
    active_subagents, active_lock, owns_record, _interrupt = api
    try:
        with active_lock:
            record = active_subagents.get(subagent_id)
            if record is None or not owns_record(record, agent):
                return False
            native_generation = record.get("delegation_id")
            return bool(delegation_id) == bool(native_generation) and delegation_id == native_generation
    except Exception:
        logger.debug("Could not verify delegated-agent stop ownership", exc_info=True)
        return False


def wrap_tool_progress_callback(
    agent: Any,
    callback: Callable | None,
    *,
    session_id: str,
    run_id: str,
    notify: Callable[[str, dict[str, Any]], Any] | None,
) -> Callable | None:
    """Wrap the native parent callback, capturing this turn's immutable app run id.

    The child relay created by Hermes retains this callback after the parent
    prompt returns, so late child updates keep the originating run id.
    """
    if not callable(callback):
        return callback
    if not _valid_session_id(session_id) or not _valid_id(run_id) or not callable(notify):
        return callback

    scope = (session_id, run_id)

    def wrapped(event_type: Any, name: str = None, preview: str = None, args: Any = None, **kwargs: Any) -> Any:
        try:
            public = _public_agent_update(event_type, preview, kwargs)
            if public is not None:
                agent_id, state = public
                with _run_agents_lock:
                    previous = _run_agents.get(scope, {}).get(agent_id)
                if previous:
                    # Preserve first start time, accumulated safe task text, and
                    # stable native identity across sparse progress ticks.
                    if previous.get("startedAt") and "startedAt" not in state:
                        state["startedAt"] = previous["startedAt"]
                    if not state.get("task") and previous.get("task"):
                        state["task"] = previous["task"]
                    if state.get("name") in {"Delegated agent"} and previous.get("name"):
                        state["name"] = previous["name"]
                    for identity_key in ("parentId", "childSessionId", "delegationId"):
                        if previous.get(identity_key) and identity_key not in state:
                            state[identity_key] = previous[identity_key]
                    if previous.get("stopRequested"):
                        state["stopRequested"] = True
                state["canStop"] = state.get("status") == "running" and _can_stop_subagent(
                    agent, agent_id, state.get("delegationId"),
                )
                if _remember(scope, agent_id, state):
                    notify(AGENT_UPDATE_METHOD, {
                        "sessionId": session_id,
                        "runId": run_id,
                        "agent": state,
                    })
        except Exception:
            # Reporting is best effort and must never alter the native tool run.
            logger.debug("Could not report delegated-agent progress", exc_info=True)
        return callback(event_type, name, preview, args, **kwargs)

    return wrapped


def make_acp_notifier(conn: Any, loop: Any) -> Callable[[str, dict[str, Any]], bool] | None:
    """Create a thread-safe sender for the private ACP `panel/agent_update` extension."""
    ext_notification = getattr(conn, "ext_notification", None)
    ext_method = getattr(conn, "ext_method", None)
    if (not callable(ext_notification) and not callable(ext_method)) or loop is None:
        return None
    cached = getattr(conn, "_panel_agent_notifier", None)
    if callable(cached):
        resume = getattr(cached, "_panel_resume_pending", None)
        if callable(resume):
            resume()
        return cached

    pending_lock = threading.Lock()
    pending: OrderedDict[tuple[str, str, str, str], dict[str, Any]] = OrderedDict()
    drain_scheduled = False

    def terminal_key(params: dict[str, Any]) -> tuple[str, str, str, str]:
        agent = params.get("agent", {})
        return (
            str(params.get("sessionId") or ""),
            str(params.get("runId") or ""),
            str(agent.get("id") or ""),
            str(agent.get("delegationId") or ""),
        )

    async def drain_pending() -> None:
        nonlocal drain_scheduled
        delays = (0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0)
        try:
            while True:
                with pending_lock:
                    if not pending:
                        return
                    key, item = next(iter(pending.items()))
                try:
                    if not callable(ext_method):
                        raise RuntimeError("ACP terminal update requests are unavailable")
                    result = await asyncio.wait_for(
                        ext_method(item["method"], item["params"]),
                        timeout=_TERMINAL_NOTIFICATION_TIMEOUT_SECONDS,
                    )
                    if not isinstance(result, dict) or result.get("ok") is not True:
                        raise RuntimeError("Control panel did not durably accept the terminal agent update")
                except Exception:
                    logger.debug("Could not send terminal Control panel agent notification", exc_info=True)
                    with pending_lock:
                        current = pending.get(key)
                        if current is item:
                            item["failures"] += 1
                            pending.move_to_end(key)
                            delay = delays[min(item["failures"] - 1, len(delays) - 1)]
                        else:
                            delay = delays[0]
                    await asyncio.sleep(delay)
                    continue
                with pending_lock:
                    if pending.get(key) is item:
                        pending.pop(key, None)
        finally:
            with pending_lock:
                drain_scheduled = False
                restart = bool(pending)
            if restart:
                schedule_drain()

    def schedule_drain() -> bool:
        nonlocal drain_scheduled
        with pending_lock:
            if drain_scheduled:
                return True
            drain_scheduled = True
        task = drain_pending()
        try:
            from agent.async_utils import safe_schedule_threadsafe

            future = safe_schedule_threadsafe(
                task, loop, logger=logger,
                log_message="Failed to schedule Control panel terminal notification delivery",
            )
            if future is not None:
                return True
        except Exception:
            logger.debug("Could not schedule terminal Control panel agent notification", exc_info=True)
        task.close()
        with pending_lock:
            drain_scheduled = False
        return False

    def notify(method: str, params: dict[str, Any]) -> bool:
        terminal = params.get("agent", {}).get("status") in {"complete", "error", "cancelled"}
        if terminal:
            key = terminal_key(params)
            with pending_lock:
                pending[key] = {"method": method, "params": params, "failures": 0}
                pending.move_to_end(key)
                while len(pending) > _PENDING_TERMINAL_LIMIT:
                    pending.popitem(last=False)
            return schedule_drain()
        try:
            if not callable(ext_notification):
                return False
            from agent.async_utils import safe_schedule_threadsafe

            future = safe_schedule_threadsafe(
                ext_notification(method, params), loop, logger=logger,
                log_message="Failed to send Control panel extension notification",
            )
            if future is None:
                return False
            future.result(timeout=5)
            return True
        except Exception:
            logger.debug("Could not send Control panel extension notification", exc_info=True)
            return False

    try:
        setattr(notify, "_panel_resume_pending", schedule_drain)
        setattr(conn, "_panel_agent_notifier", notify)
    except Exception:
        pass
    return notify


def _delegation_control_api():
    """Return the installed runtime's exact live-child control primitives, or None if unavailable."""
    try:
        from agent.interrupt_compat import request_hard_interrupt
        from tools import delegate_tool_registry as registry
    except Exception:
        return None
    required = (
        getattr(registry, "_active_subagents", None),
        getattr(registry, "_active_subagents_lock", None),
        getattr(registry, "_owns_subagent_record", None),
        request_hard_interrupt,
    )
    if required[0] is None or required[1] is None or not all(callable(item) for item in required[2:]):
        return None
    return required


def stop_subagent(
    agent: Any, subagent_id: Any, *, session_id: str, run_id: str,
    delegation_id: Any = None,
) -> dict[str, Any]:
    """Request a cooperative stop for one live child owned by the specified parent run.

    Queued children are not registered in Hermes' live-child registry yet and
    cannot be stopped individually through its native control API. Parent-run
    cancellation remains the separate way to stop every child in that run.
    """
    if (not _valid_id(subagent_id) or not _valid_id(run_id) or not _valid_session_id(session_id)
            or (delegation_id is not None and not _valid_id(delegation_id))):
        return {"ok": False, "error": "invalid_request"}
    if not agent or str(getattr(agent, "session_id", "") or "") != session_id:
        return {"ok": False, "error": "parent_session_mismatch"}

    scope = (session_id, run_id)
    with _run_agents_lock:
        state_ref = _run_agents.get(scope, {}).get(subagent_id)
        state = dict(state_ref or {})
    if not state:
        return {"ok": False, "error": "agent_not_in_run"}
    if delegation_id is not None and state.get("delegationId") != delegation_id:
        return {"ok": False, "error": "agent_generation_mismatch"}
    if state.get("status") != "running":
        return {"ok": False, "error": "agent_not_running", "status": state.get("status")}
    api = _delegation_control_api()
    if api is None:
        return {"ok": False, "error": "delegation_control_unavailable"}
    active_subagents, active_lock, owns_record, interrupt_agent = api
    try:
        with active_lock:
            record = active_subagents.get(subagent_id)
            if record is None or not owns_record(record, agent):
                return {"ok": False, "error": "agent_not_active"}
            native_agent = record.get("agent")
            expected_generation = state.get("delegationId")
            if native_agent is None:
                return {"ok": False, "error": "agent_not_active"}
            native_generation = record.get("delegation_id")
            if bool(expected_generation) != bool(native_generation) or expected_generation != native_generation:
                return {"ok": False, "error": "agent_generation_mismatch"}
        if state.get("stopRequested"):
            return {"ok": True, "status": "interrupt_requested", "agentId": subagent_id, "duplicate": True}
        # Interrupt the exact child object captured above. Re-looking it up by
        # public ID here could target a replacement registered after the lock
        # was released.
        if not interrupt_agent(native_agent, f"Interrupted via Panel ({subagent_id})"):
            return {"ok": False, "error": "agent_not_active"}
    except Exception:
        logger.debug("Could not stop delegated agent", exc_info=True)
        return {"ok": False, "error": "delegation_control_failed"}

    with _run_agents_lock:
        current = _run_agents.get(scope, {}).get(subagent_id)
        expected_generation = state.get("delegationId")
        same_generation = bool(current) and (
            current.get("delegationId") == expected_generation if expected_generation else current is state_ref
        )
        if same_generation and current.get("status") == "running":
            current["stopRequested"] = True
            current["updatedAt"] = _timestamp()
    return {"ok": True, "status": "interrupt_requested", "agentId": subagent_id}


def handle_panel_method(agent: Any, method: str, params: Any) -> dict[str, Any] | None:
    """Handle the private ACP agent-control method; unknown methods return None to the caller."""
    if method != STOP_AGENT_METHOD or not isinstance(params, dict):
        return None
    return stop_subagent(
        agent,
        params.get("agentId"),
        session_id=params.get("sessionId", ""),
        run_id=params.get("runId", ""),
        delegation_id=params.get("delegationId"),
    )


def delegation_capability() -> dict[str, Any]:
    """Non-throwing runtime capability snapshot for adapter startup and diagnostics."""
    api = _delegation_control_api()
    return {
        "available": api is not None,
        "agentUpdateMethod": AGENT_UPDATE_METHOD,
        "stopMethod": STOP_AGENT_METHOD,
        "individualStop": api is not None,
    }


def _reset_for_tests() -> None:
    with _run_agents_lock:
        _run_agents.clear()
