"""Metadata only: neither prompts, tool arguments, nor results are recorded."""
import json
import os
import sys
import tempfile
import fcntl
from datetime import datetime, timezone
from .config import control_home

_FIELDS = {"mode", "tool", "model", "elapsedMs", "confidence", "reason", "progress", "skippedFrontier", "contextPairs", "removedChars", "evaluated"}
_METRIC_FIELDS = {"decisions", "direct", "forced", "fallback", "totalDecisionMs",
                  "providerAttempts", "providerSuccesses", "providerFailures", "providerTimeouts"}
_REASONS = {"uncertain_selection", "needs_hermes_reasoning", "compose_final_answer",
            "hermes_fills_arguments", "grounded_read_arguments", "progress_checked",
            "reconsider_failed_strategy", "tools_required_by_host", "provider_thinking_requires_auto",
            "provider_finish_keeps_tools_available",
            "invalid_choice_schema", "unknown_choice", "missing_confidence", "below_confidence",
            "incomplete_probabilities", "invalid_probabilities", "diffuse_selection", "inconsistent_selection"}


def _metrics(previous):
    source = previous.get("metrics", {}) if isinstance(previous, dict) else {}
    metrics = {key: max(0, value) for key, value in source.items()
               if key in _METRIC_FIELDS and isinstance(value, (float, int))}
    return metrics


def _update_document(mutator):
    temporary = None
    try:
        folder = control_home()
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = folder / "jev-runtime.json"
        lock_fd = os.open(folder / ".jev-runtime.lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(lock_fd, "w") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX)
            try:
                previous = json.loads(destination.read_text())
            except (OSError, ValueError):
                previous = {}
            if not isinstance(previous, dict):
                previous = {}
            document = mutator(previous)
            fd, temporary = tempfile.mkstemp(prefix=".jev-runtime-", dir=folder)
            with os.fdopen(fd, "w") as target:
                json.dump(document, target)
            os.replace(temporary, destination)
    except Exception:
        # Diagnostics are best-effort and must never affect the Hermes request.
        pass
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def record_transport(kind, receipt=None):
    """Persist transport evidence without provider bodies, prompts, or keys."""
    field = {"attempt": "providerAttempts", "success": "providerSuccesses",
             "failure": "providerFailures", "timeout": "providerTimeouts"}.get(kind)
    if not field:
        return
    at = datetime.now(timezone.utc).isoformat()

    def update(previous):
        metrics = _metrics(previous)
        metrics[field] = metrics.get(field, 0) + 1
        safe_receipt = {key: value for key, value in (receipt or {}).items()
                        if key in {"requestIdHash", "inputTokens", "outputTokens", "totalTokens"}
                        and (isinstance(value, int) and value >= 0 or isinstance(value, str) and len(value) <= 24)}
        return {**previous, "version": 1, "at": at, "metrics": metrics,
                "providerTrackingSince": previous.get("providerTrackingSince") or at,
                "lastProviderCall": {"at": at, "outcome": kind, **safe_receipt}}

    _update_document(update)


def emit(event, **context):
    row = {key: value for key, value in event.items() if key in _FIELDS}
    row.update(version=1, at=datetime.now(timezone.utc).isoformat(),
               sessionId=str(context.get("session_id") or ""),
               turnId=str(context.get("turn_id") or ""), iteration=context.get("api_call_count", 0))
    print("HERMES_JEV_EVENT " + json.dumps(row, ensure_ascii=False), file=sys.stderr, flush=True)
    def update(previous):
            metrics = _metrics(previous)
            context_event = str(row.get("mode", "")).startswith("context")
            if not context_event and row.get("evaluated", False):
                metrics["decisions"] = metrics.get("decisions", 0) + 1
                mode = row.get("mode")
                if mode in {"direct", "forced", "fallback"}:
                    metrics[mode] = metrics.get(mode, 0) + 1
                reason = row.get("reason")
                reasons = previous.get("reasons", {}) if isinstance(previous.get("reasons"), dict) else {}
                reasons = {key: max(0, value) for key, value in reasons.items()
                           if key in _REASONS and isinstance(value, (int, float))}
                if reason in _REASONS:
                    reasons[reason] = reasons.get(reason, 0) + 1
                metrics["totalDecisionMs"] = metrics.get("totalDecisionMs", 0) + max(0, row.get("elapsedMs", 0))
            metrics["averageDecisionMs"] = round(metrics.get("totalDecisionMs", 0) / max(1, metrics.get("decisions", 0)))
            # Retries, cooldowns, disabled paths, and other non-evaluated bypasses
            # must not overwrite the last observed Jev decision.
            observed = row.get("evaluated", False)
            document = {"version": 1, "at": row["at"], "metrics": metrics,
                        "lastDecision": previous.get("lastDecision") if context_event or not observed else row}
            document["reasons"] = reasons if observed and not context_event else previous.get("reasons", {})
            if context_event:
                document["lastContext"] = row
            elif isinstance(previous.get("lastContext"), dict):
                document["lastContext"] = previous["lastContext"]
            if isinstance(previous.get("lastProviderCall"), dict):
                document["lastProviderCall"] = previous["lastProviderCall"]
            if previous.get("providerTrackingSince"):
                document["providerTrackingSince"] = previous["providerTrackingSince"]
            return document

    _update_document(update)
