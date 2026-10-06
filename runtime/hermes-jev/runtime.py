"""One Jev decision per eligible agent iteration, inside Hermes' execution middleware."""
import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict

from .client import DecisionUnavailable, request_decisions
from .config import control_home, load_config
from .decision import DEFER, FINISH, RECOVERY, build_questions, direct_arguments, inspect_choice, noul_probability, progress_questions, valid_choice
from .diagnostics import emit
from .wire import SUPPORTED, deepseek_finish_keeps_tools_available, force_tool, tool_response, tool_schemas

_states = OrderedDict()
_lock = threading.RLock()
_health = {}


def _key(context):
    return str(control_home()), str(context.get("session_id") or ""), str(context.get("turn_id") or "")


def _state(context):
    key = _key(context)
    with _lock:
        if key not in _states:
            _states[key] = {"tools": [], "seen": set(), "direct": set(), "recovery": None, "lastMonitor": 0}
        _states.move_to_end(key)
        while len(_states) > 256:
            _states.popitem(last=False)
        return _states[key]


def _active_tool_turn(context):
    # Tool observer hooks omit the platform. The preceding LLM middleware call
    # records Discord's platform under the same profile/session/turn identity.
    if os.environ.get("HERMES_JEV_CONTROL") == "1":
        return True
    with _lock:
        return bool(_states.get(_key(context), {}).get("discordActive"))


def _redact(value):
    from agent.redact import redact_sensitive_text
    return redact_sensitive_text(value, force=True, redact_url_credentials=True)


def _plain_text(value):
    # Binary blobs occasionally arrive as an otherwise textual tool result.
    return re.sub(r"[A-Za-z0-9+/]{500,}={0,2}", "[binary content omitted]", value)


def _visible_content(content):
    if isinstance(content, str):
        return _plain_text(content)
    if not isinstance(content, list):
        return ""
    blocks = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind in {"text", "input_text", "output_text"}:
            blocks.append({"type": "text", "text": _plain_text(str(block.get("text") or ""))})
        elif kind == "tool_use":
            blocks.append({"type": kind, "name": block.get("name"), "input": block.get("input", {})})
        elif kind == "tool_result":
            blocks.append({"type": kind, "is_error": block.get("is_error", False),
                           "content": _visible_content(block.get("content", ""))})
        # Thinking, signatures, images, and audio are never sent to the selector.
    return blocks


def request_state(request, api_mode, recent_tools):
    rows = request.get("messages") if api_mode != "codex_responses" else request.get("input")
    if not isinstance(rows, list):
        rows = []
    conversation = []
    latest_goal = ""
    truncated = False
    for row in rows:
        if not isinstance(row, dict) or row.get("role") in {"system", "developer"}:
            continue
        if row.get("type") in {"reasoning", "compaction"}:
            continue
        if row.get("role") == "user":
            raw_content = row.get("content", "")
            if isinstance(raw_content, str):
                visible_goal = raw_content
            elif isinstance(raw_content, list):
                visible_goal = "\n".join(str(block.get("text") or "") for block in raw_content
                                         if isinstance(block, dict) and block.get("type") in {"text", "input_text"})
            else:
                visible_goal = ""
            # Anthropic encodes tool results as user messages; only actual user text updates the goal.
            if visible_goal.strip():
                latest_goal = _redact(_plain_text(visible_goal))
        # Exclude encrypted/provider-internal reasoning, include actual visible calls/results.
        entry = {k: row[k] for k in ("role", "type", "name", "content", "tool_calls", "output", "arguments") if k in row}
        if "content" in entry:
            entry["content"] = _visible_content(entry["content"])
        if "output" in entry:
            entry["output"] = _visible_content(entry["output"])
        text = _plain_text(json.dumps(entry, ensure_ascii=False, default=str))
        if len(text) > 5000:
            text = text[:3000] + "\n[content shortened for tool selection]\n" + text[-1500:]
            truncated = True
        conversation.append(_redact(text))
    if len(conversation) > 12:
        conversation = conversation[-12:]
        truncated = True
    while sum(map(len, conversation)) > 25_000 and len(conversation) > 1:
        conversation.pop(0)
        truncated = True
    if len(latest_goal) > 5000:
        latest_goal = latest_goal[:3500] + "\n[user goal shortened]\n" + latest_goal[-1000:]
        truncated = True
    outcomes = [{k: v for k, v in entry.items() if k != "signature"} for entry in recent_tools[-9:]]
    return {"latest_user_goal": latest_goal, "recent_conversation": conversation, "recent_tool_outcomes": outcomes,
            "context_shortened": truncated, "purpose": "Select the next tool; do not generate commands, prose, or unlisted arguments."}


def installed_skills():
    try:
        from tools.skills_tool import skills_list
        rows = json.loads(skills_list()).get("skills", [])
        if len(rows) > 250:
            return None
        return {row["name"]: row["name"] + ": " + str(row.get("description") or "")[:350]
                for row in rows if isinstance(row, dict) and isinstance(row.get("name"), str)}
    except Exception:
        return None


def _health_result(profile, reason):
    with _lock:
        health = _health.setdefault(profile, {"failures": 0, "retryAt": 0})
        if reason in {"authentication", "unavailable", "timeout", "invalid_response"}:
            health["failures"] += 1
            if health["failures"] >= 3 or reason == "authentication":
                health["retryAt"] = time.monotonic() + 60
        elif reason == "success":
            health.update(failures=0, retryAt=0)


def recovery_request(request, api_mode, note):
    """Add a harness note to the newest result in this request, without editing history."""
    key = "input" if api_mode == "codex_responses" else "messages"
    rows = request.get(key)
    if not isinstance(rows, list):
        return request
    suffix = "\n\n[Hermes progress check: " + note + " Reconsider this before the next action. This does not grant new permissions.]"
    for index in range(len(rows) - 1, -1, -1):
        row = rows[index]
        if not isinstance(row, dict):
            continue
        if row.get("role") == "tool" and isinstance(row.get("content"), str):
            changed = {**row, "content": row["content"] + suffix}
        elif row.get("type") == "function_call_output" and isinstance(row.get("output"), str):
            changed = {**row, "output": row["output"] + suffix}
        elif api_mode == "anthropic_messages" and isinstance(row.get("content"), list):
            blocks = row["content"]
            block_index = next((i for i in range(len(blocks) - 1, -1, -1)
                                if isinstance(blocks[i], dict) and blocks[i].get("type") == "tool_result"), None)
            if block_index is None:
                continue
            block = blocks[block_index]
            content = block.get("content", "")
            content = content + suffix if isinstance(content, str) else [*content, {"type": "text", "text": suffix}] if isinstance(content, list) else suffix
            changed = {**row, "content": [*blocks[:block_index], {**block, "content": content}, *blocks[block_index + 1:]]}
        else:
            continue
        return {**request, key: [*rows[:index], changed, *rows[index + 1:]]}
    return request


def select_next_tool(request, next_call, **context):
    """Short-circuit only a grounded read; otherwise constrain choice, then ask Hermes for args."""
    config = load_config(platform=context.get("platform"))
    if not config["enabled"] or not config["apiKey"] or not (config["toolSelection"] or config["monitorProgress"]):
        return next_call(request)
    current = _state(context)
    if context.get("platform") == "discord":
        with _lock:
            current["discordActive"] = True
    started = time.monotonic()
    mode = context.get("api_mode", "chat_completions")
    evaluated = False

    def fallback(reason, *, tool=None, confidence=None, progress=None, effective_request=None):
        emit({"mode": "fallback", "reason": reason, "tool": tool, "confidence": confidence,
              "elapsedMs": round((time.monotonic() - started) * 1000), "progress": progress, "skippedFrontier": False,
              "evaluated": evaluated}, **context)
        return next_call(request if effective_request is None else effective_request)

    if mode not in SUPPORTED:
        return fallback("unsupported_provider")
    choice = request.get("tool_choice")
    choice_mode = choice.get("type") if isinstance(choice, dict) else choice
    tools = tool_schemas(request, mode)
    # Even an empty live catalog is a useful decision: Jev chooses FINISH or
    # DEFER before Hermes generates prose. The per-turn state key ensures a new
    # user prompt is evaluated afresh; identical provider retries remain free.
    select_tools = config["toolSelection"] and choice_mode in (None, "auto", "required", "any")
    if select_tools and (len(tools) > 253 or DEFER in tools or FINISH in tools):
        return fallback("tool_catalog_too_large")
    profile = str(control_home())
    with _lock:
        cooling_down = _health.get(profile, {}).get("retryAt", 0) > time.monotonic()
    if cooling_down:
        return fallback("cooldown")
    with _lock:
        recent = list(current["tools"])
        monitor = config["monitorProgress"] and len(recent) >= 3 and len(recent) - current["lastMonitor"] >= 3
    if not select_tools and not monitor:
        return next_call(request)
    decision_state = request_state(request, mode, recent)
    if not select_tools:
        decision_state["purpose"] = "Evaluate progress and recovery only; do not select tools or generate arguments."
    fingerprint = hashlib.sha256(json.dumps({"state": decision_state, "tools": tools if select_tools else {}}, sort_keys=True, default=str).encode()).hexdigest()
    with _lock:
        repeated_request = fingerprint in current["seen"]
        current["seen"].add(fingerprint)
    # Provider retries must neither re-charge Jev nor replay a rejected forced choice.
    if repeated_request:
        return fallback("unchanged_request_retry")
    allow_direct = config.get("directDispatch", True)
    skills = installed_skills() if select_tools and allow_direct and any(name.removeprefix("mcp__") == "skill_view" for name in tools) else None
    questions, plans = build_questions(tools, skills, monitor, allow_direct=allow_direct) if select_tools else (progress_questions(), {})
    try:
        evaluated = True
        response = request_decisions(decision_state, questions, config)
    except DecisionUnavailable as exc:
        if exc.reason in {"not_configured", "decision_too_large", "previous_request_pending"}:
            evaluated = False
        _health_result(profile, exc.reason)
        return fallback(exc.reason)
    answers = response.get("answers", {})
    decision, rejection, rejected_confidence = inspect_choice(answers.get("next_tool"), questions["next_tool"]["criteria"], config["minConfidence"]) if select_tools else (None, None, None)
    _health_result(profile, "success")
    selected, confidence = decision if decision else (None, None)
    progress = None
    if monitor:
        with _lock:
            current["lastMonitor"] = len(recent)
        recovery = valid_choice(answers.get("recovery"), RECOVERY)
        making = noul_probability(answers.get("is_making_progress"))
        repeating = noul_probability(answers.get("is_repeating_failed_strategy"))
        if recovery and (making is not None and making <= 0.2 or repeating is not None and repeating >= 0.8):
            progress = recovery[0]
            if progress != "continue":
                with _lock:
                    current["recovery"] = RECOVERY[progress]
                adjusted = recovery_request(request, mode, RECOVERY[progress])
                return fallback("reconsider_failed_strategy", tool=selected if selected in tools else None, confidence=confidence,
                                progress=progress, effective_request=adjusted)
    elapsed = round((time.monotonic() - started) * 1000)
    event = {"tool": selected if selected in tools else None, "confidence": confidence,
             "elapsedMs": elapsed, "progress": progress, "skippedFrontier": False, "evaluated": True}
    if not select_tools:
        emit({**event, "mode": "defer", "reason": "progress_checked"}, **context)
        return next_call(request)
    if decision is None:
        return fallback(rejection or "invalid_choice_schema", confidence=rejected_confidence)
    if selected == DEFER:
        emit({**event, "mode": "defer", "reason": "needs_hermes_reasoning"}, **context)
        return next_call(request)
    if selected == FINISH:
        if choice_mode in {"required", "any"}:
            return fallback("tools_required_by_host")
        final_request = force_tool(request, None, mode, provider=context.get("provider", ""), model=context.get("model", ""))
        if final_request is None:
            reason = ("provider_finish_keeps_tools_available"
                      if deepseek_finish_keeps_tools_available(request, provider=context.get("provider", ""), model=context.get("model", ""))
                      else "provider_thinking_requires_auto")
            # Hermes's execution middleware permits one downstream provider call.
            # A second call here raises a contract error and can lose the turn.
            return fallback(reason, confidence=confidence)
        emit({**event, "mode": "finish", "reason": "compose_final_answer"}, **context)
        return next_call(final_request)
    args = direct_arguments(selected, tools, plans, questions, answers) if config.get("directDispatch", True) else None
    if args is not None:
        signature = json.dumps([selected, args], sort_keys=True)
        with _lock:
            used = signature in current["direct"]
            if not used:
                current["direct"].add(signature)
        if not used:
            emit({**event, "mode": "direct", "reason": "grounded_read_arguments", "skippedFrontier": True}, **context)
            return tool_response(selected, args, mode, context.get("model", ""))
    forced_request = force_tool(request, selected, mode, provider=context.get("provider", ""), model=context.get("model", ""))
    if forced_request is None:
        return fallback("provider_thinking_requires_auto", tool=selected, confidence=confidence)
    emit({**event, "mode": "forced", "reason": "hermes_fills_arguments"}, **context)
    return next_call(forced_request)


def observe_tool(tool_name, args, result, status=None, **context):
    if not _active_tool_turn(context):
        return
    current = _state(context)
    # Hashes detect identical retries locally; only names and status enter Jev's outcome list.
    signature = hashlib.sha256(json.dumps([tool_name, args, result], sort_keys=True, default=str).encode()).hexdigest()
    with _lock:
        repeated = any(item.get("signature") == signature for item in current["tools"][-6:])
        current["tools"].append({"tool": tool_name, "status": status or "unknown", "repeated_identically": repeated,
                                 "signature": signature})
        if len(current["tools"]) > 100:
            del current["tools"][:50]
            current["lastMonitor"] = max(0, current["lastMonitor"] - 50)


def annotate_result(tool_name, result, **context):
    if not _active_tool_turn(context) or not isinstance(result, str):
        return None
    current = _state(context)
    with _lock:
        note, current["recovery"] = current["recovery"], None
    if note:
        return result + "\n\n[Hermes progress check: " + note + " This is a recovery suggestion, not authorization for a new action.]"
    return None


def end_session(session_id, **kwargs):
    profile = str(control_home())
    with _lock:
        for key in list(_states):
            if key[0] == profile and key[1] == session_id:
                del _states[key]
