"""Control Center model routing using Hermes' configured primary and fallbacks."""

from .model_router import choose_turn_model

_ROUTE_FIELDS = ("base_url", "api_mode", "api_key", "api_key_env", "key_env",
                 "extra_headers", "extra_body", "reasoning_effort", "temperature",
                 "max_tokens", "top_p")


def _entries(value):
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def _same_route(primary, fallback):
    """A model ID alone cannot carry per-route endpoint or request overrides."""
    for key in _ROUTE_FIELDS:
        current = primary.get(key)
        alternative = fallback.get(key)
        # The Control CLI keeps the primary route. An omitted fallback field
        # inherits it; only an explicit incompatible override must be rejected.
        if alternative in (None, "", {}, []):
            continue
        if key == "base_url":
            current = str(current or "").rstrip("/")
            alternative = str(alternative).rstrip("/")
        if current != alternative:
            return False
    return True


def configured_candidates(config, *, max_candidates=4):
    """Return the primary and at most three safe, same-provider fallback model IDs."""
    primary = config.get("model") if isinstance(config, dict) else None
    primary = primary if isinstance(primary, dict) else {}
    provider = str(primary.get("provider") or "").strip()
    model = str(primary.get("default") or primary.get("model") or "").strip()
    if not provider or not model or max_candidates < 2:
        return provider, model, []

    candidates = [model]
    seen_routes = set()
    for key in ("fallback_providers", "fallback_model"):
        for entry in _entries(config.get(key)):
            candidate_provider = str(entry.get("provider") or "").strip()
            candidate_model = str(entry.get("model") or "").strip()
            if candidate_provider.lower() != provider.lower() or not candidate_model:
                continue
            route_key = (candidate_provider.lower(), candidate_model.lower(), str(entry.get("base_url") or "").strip().rstrip("/").lower())
            if route_key in seen_routes:
                continue
            seen_routes.add(route_key)
            if not _same_route(primary, entry) or candidate_model in candidates:
                continue
            try:
                from hermes_cli.model_switch import model_derived_api_mode
                api_key = str(primary.get("api_key") or "")
                if model_derived_api_mode(provider, model, api_key) != model_derived_api_mode(provider, candidate_model, api_key):
                    continue
            except Exception:
                # An unsupported host cannot establish transport compatibility.
                continue
            candidates.append(candidate_model)
            if len(candidates) >= max_candidates:
                return provider, model, candidates
    return provider, model, candidates


def choose_control_model(user_message, config, *, explicit_provider="", explicit_model="", **context):
    """Choose from the default Control route; explicit voice selection stays authoritative."""
    if explicit_provider or explicit_model or not isinstance(config, dict):
        return None
    provider, model, candidates = configured_candidates(config)
    if len(candidates) < 2:
        return None
    return choose_turn_model(user_message, model, provider, candidates, platform="control", **context)
