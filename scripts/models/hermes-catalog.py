"""Small bridge to the installed Hermes provider registry; stdout is JSON only.

Catalog reads never return credential values. Only the server-only resolve action
returns a key, directly to the Node server process which performs voice requests.
"""
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile


def read_json(file, default=None):
    try:
        return json.loads(Path(file).read_text())
    except (OSError, ValueError):
        return default if default is not None else {}


def read_config(file, yaml):
    """Read the local selection config without exposing parser text or config contents."""
    try:
        raw = file.read_text()
    except FileNotFoundError:
        return {}, "Hermes configuration is missing. Showing available local catalogs; run hermes setup before selecting a model."
    except OSError:
        return {}, "Hermes configuration could not be read. Showing available local catalogs; run npm run doctor for local diagnostics."
    try:
        value = yaml.safe_load(raw)
    except Exception:
        return {}, "Hermes configuration could not be parsed. Showing cached models only; run npm run doctor for local diagnostics."
    if value is None:
        return {}, ""
    if not isinstance(value, dict):
        return {}, "Hermes configuration has an unexpected format. Showing cached models only; run npm run doctor for local diagnostics."
    return value, ""


def model_ids(raw):
    if isinstance(raw, dict):
        return [str(value.get("id") or key) if isinstance(value, dict) else str(value or key) for key, value in raw.items()]
    if isinstance(raw, (list, tuple)):
        return [str(value.get("id") or value.get("model") or "") if isinstance(value, dict) else str(value) for value in raw]
    return []


def valid_model(value):
    return isinstance(value, str) and 0 < len(value) <= 200 and not re.search(r"[\s\x00-\x1f\x7f]", value)


def config_environment_names(config):
    """Find custom connection env references without returning config values."""
    names = set()
    valid = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,119}$")

    def add(value):
        if isinstance(value, str) and valid.fullmatch(value):
            names.add(value)

    def visit(value, field=""):
        if isinstance(value, dict):
            for key, item in value.items():
                visit(item, str(key))
        elif isinstance(value, (list, tuple)):
            for item in value:
                visit(item, field)
        elif isinstance(value, str):
            if field in {"key_env", "api_key_env", "env_key"} or field.endswith(("_env", "_env_var", "_env_vars", "_env_key")):
                add(value)
            for match in re.finditer(r"\$(?:\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))", value):
                add(match.group(1) or match.group(2))

    visit(config)
    return names


def connection_config_revision(config, definitions=None):
    """Server-only connection fingerprint, independent of saved model roles."""
    definitions = definitions or {}
    fields = {"api_key", "api_key_env", "key_env", "key_cmd", "env_key", "base_url", "url", "api_mode", "transport", "extra_headers", "account", "account_id", "organization", "organization_id", "project", "project_id", "profile", "region", "tenant", "tenant_id", "enabled"}

    def connection_fields(block):
        return {key: value for key, value in block.items() if key in fields} if isinstance(block, dict) else {}

    routes = {provider: {"base_url": value.get("baseUrl") or "", "transport": value.get("transport") or ""} for provider, value in definitions.items()}
    overrides = set()
    for field in ("model", "fallback_model"):
        block = config.get(field)
        if not isinstance(block, dict):
            continue
        provider = str(block.get("provider") or "")
        entry = connection_fields(block)
        route = routes.get(provider, {})
        # Assignment writes may make a provider's existing default endpoint
        # explicit. Those identical routes are not credential/account changes.
        for name in ("base_url", "url"):
            if str(entry.get(name) or "").rstrip("/") == str(route.get("base_url") or "").rstrip("/"):
                entry.pop(name, None)
        for name in ("api_mode", "transport"):
            if entry.get(name) == route.get("transport"):
                entry.pop(name, None)
        if entry:
            overrides.add(json.dumps({"provider": provider, "connection": entry}, sort_keys=True, separators=(",", ":")))
    entries = []
    for name, block in (config.get("providers") or {}).items():
        entries.append({"provider": str(name), "connection": connection_fields(block)})
    for block in config.get("custom_providers") or []:
        if isinstance(block, dict):
            entries.append({"provider": str(block.get("name") or block.get("provider") or "custom"), "connection": connection_fields(block)})
    entries.sort(key=lambda entry: json.dumps(entry, sort_keys=True))
    value = {"routes": routes, "overrides": sorted(overrides), "entries": entries}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def provider_credential_revision(provider, config, definition, auth_store, environment):
    """Hash one provider's local connection/account material, never bookkeeping.

    This deliberately avoids credential resolvers: some can refresh OAuth or
    probe alternative inference endpoints. Catalog reads remain local-only.
    """
    scope = {}
    for field in ("model", "fallback_model"):
        block = config.get(field)
        if isinstance(block, dict) and block.get("provider") == provider:
            scope[field] = block
    if definition.get("entry"):
        scope["providers"] = {provider: definition["entry"]}
    names = set(definition.get("credentialEnvVars") or []) | config_environment_names(scope)
    material_fields = {"access_token", "refresh_token", "id_token", "agent_key", "api_key", "runtime_api_key", "secret_fingerprint", "key_fingerprint", "key_hash", "client_id", "client_secret", "account", "account_id", "organization", "organization_id", "project", "project_id", "tenant", "tenant_id", "base_url", "inference_base_url", "portal_base_url", "detected_endpoint", "extra_headers", "tls", "auth_type", "source", "priority", "id"}

    def material(value):
        if isinstance(value, dict):
            return {key: material(item) if isinstance(item, (dict, list)) and key not in {"extra_headers", "tls"} else item for key, item in value.items() if key in material_fields}
        if isinstance(value, list):
            return [material(item) for item in value if isinstance(item, dict)]
        return {}

    provider_states = auth_store.get("providers") or {}
    pools = auth_store.get("credential_pool") or {}
    value = {
        "provider": provider,
        "connection": connection_config_revision(scope, {provider: definition}),
        "environment": {name: str(environment.get(name) or "") for name in sorted(names)},
        "account": material(provider_states.get(provider, {})) if isinstance(provider_states, dict) else {},
        "pool": material(pools.get(provider, [])) if isinstance(pools, dict) else [],
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def probe_token_limit_parameter(model, base_url):
    """Match Hermes's chat token-cap compatibility without constructing an agent."""
    from urllib.parse import urlparse
    try:
        from utils import model_forces_max_completion_tokens
        requires_completion_limit = model_forces_max_completion_tokens(model)
    except ImportError:
        # Older Hermes installs may lack the shared helper.
        requires_completion_limit = str(model or "").lower().rsplit("/", 1)[-1].startswith(("gpt-4o", "gpt-4.1", "gpt-5", "o1", "o3", "o4"))
    host = urlparse(str(base_url or "")).hostname or ""
    native = host == "api.openai.com" or host == "openai.azure.com" or host.endswith(".openai.azure.com")
    return "max_completion_tokens" if native or requires_completion_limit else "max_tokens"


# NVIDIA's discovery list is not an inference-access check. Exclude only known
# non-chat services and hosted endpoints explicitly deprecated in NVIDIA's own
# catalog (reviewed 2026-09-19). New IDs do not need a hard-coded allowlist entry.
# These statuses apply to NVIDIA's shared hosted API, not self-hosted NIMs.
NVIDIA_DEPRECATED_HOSTED = {
    "meta/llama3-8b-instruct": "https://build.nvidia.com/meta/llama3-8b",
    "meta/llama3-70b-instruct": "https://build.nvidia.com/meta/llama3-70b",
    "meta/llama-3.1-8b-instruct": "https://build.nvidia.com/meta/llama-3_1-8b-instruct",
    "meta/llama-3.1-70b-instruct": "https://build.nvidia.com/meta/llama-3_1-70b-instruct",
    "meta/llama-3.2-1b-instruct": "https://build.nvidia.com/meta/llama-3.2-1b-instruct",
    "meta/llama-3.3-70b-instruct": "https://build.nvidia.com/meta/llama-3_3-70b-instruct",
    "deepseek-ai/deepseek-r1": "https://build.nvidia.com/deepseek-ai/deepseek-r1",
    "deepseek-ai/deepseek-v3.1-terminus": "https://build.nvidia.com/deepseek-ai/deepseek-v3_1-terminus",
    "deepseek-ai/deepseek-v4-flash": "https://build.nvidia.com/deepseek-ai/deepseek-v4-flash?nim=self-hosted",
    "deepseek-ai/deepseek-v4-pro": "https://build.nvidia.com/deepseek-ai/deepseek-v4-pro/build",
    "deepseek-ai/deepseek-v4-pro-0813": "https://build.nvidia.com/deepseek-ai/deepseek-v4-pro",
    "moonshotai/kimi-k2-instruct": "https://build.nvidia.com/moonshotai/kimi-k2-instruct",
    "moonshotai/kimi-k2-thinking": "https://build.nvidia.com/moonshotai/kimi-k2-thinking",
    "moonshotai/kimi-k2-instruct-0905": "https://build.nvidia.com/moonshotai/kimi-k2-instruct-0905",
    "qwen/qwen3-next-80b-a3b-instruct": "https://build.nvidia.com/qwen/qwen3-next-80b-a3b-instruct",
    "qwen/qwen3-coder-480b-a35b-instruct": "https://build.nvidia.com/qwen/qwen3-coder-480b-a35b-instruct/deploy",
    "mistralai/mistral-7b-instruct-v0.3": "https://build.nvidia.com/mistralai/mistral-7b-instruct-v03",
    "mistralai/mistral-small-24b-instruct": "https://build.nvidia.com/mistralai/mistral-small-24b-instruct",
    "mistralai/mistral-small-4-119b-2603": "https://build.nvidia.com/mistralai/mistral-small-4-119b-2603/build",
    "mistralai/mistral-large-3-675b-instruct-2512": "https://build.nvidia.com/mistralai/mistral-large-3-675b-instruct-2512",
    "mistralai/mistral-medium-3.5-128b": "https://build.nvidia.com/mistralai/mistral-medium-3.5-128b",
    "mistralai/devstral-2-123b-instruct-2512": "https://build.nvidia.com/mistralai/devstral-2-123b-instruct-2512",
    "mistralai/mixtral-8x7b-instruct-v0.1": "https://build.nvidia.com/mistralai/mixtral-8x7b-instruct",
    "mistralai/mixtral-8x22b-instruct-v0.1": "https://build.nvidia.com/mistralai/mixtral-8x22b-instruct",
    "google/gemma-3-1b-it": "https://build.nvidia.com/google/gemma-3-1b-it",
}
NVIDIA_NON_CHAT = re.compile(r"(?:embed|rerank|reward|guard|content-safety|topic-control|riva-|nemotron-parse|nvclip|synthetic-video-detector|ising-calibration|/deplot$)", re.I)
MAX_REFRESH_PROVIDERS = 4


def nvidia_model_status(model, hosted=True):
    if hosted and model in NVIDIA_DEPRECATED_HOSTED:
        return {"available": False, "availability": "deprecated", "availabilityNote": "NVIDIA lists this shared hosted endpoint as deprecated. Self-hosted availability is separate."}
    if NVIDIA_NON_CHAT.search(model):
        return {"available": False, "availability": "non-chat", "availabilityNote": "This is a specialized service rather than a general conversation model."}
    return {"availability": "unverified"}


def nvidia_chat_models(models, hosted=True):
    return [model for model in models or [] if valid_model(model) and nvidia_model_status(model, hosted).get("available") is not False]


def selection_model(model, provider, hosted=True, listed=False):
    status = nvidia_model_status(model, hosted) if provider == "nvidia" else {"availability": "unverified"}
    if not listed and status.get("available") is not False:
        status = {"availability": "not-listed", "availabilityNote": "Saved in your configuration; this ID is not in the displayed catalog. Inference access has not been checked."}
    return {"id": model, "label": model, "source": "current-config", **status}


def provider_is_configured(auth, descriptor, pool_present=False, local_key_present=False):
    """Use local state only; provider auth-status handlers may refresh credentials over the network."""
    return bool(auth or getattr(descriptor, "keyless", False) or pool_present or local_key_present)


def provider_supports_probe(slug, auth_type, transport, configured, base_url, key_cmd=False):
    # Copilot chooses its protocol and required headers per model through Hermes.
    # A generic direct API test would misleadingly fail some valid native models.
    return bool(configured and base_url and not key_cmd and slug not in {"copilot", "github-copilot"}
                and auth_type in {"api_key", "custom"}
                and transport in {"openai_chat", "chat_completions", "anthropic_messages", "codex_responses"})


def select_refresh_targets(rows, provider="", limit=MAX_REFRESH_PROVIDERS):
    """Choose a bounded set of configured API catalogs; an explicit provider is targeted."""
    candidates = [row for row in rows if row.get("supportsCatalog") and (not provider or row.get("id") == provider)]
    return candidates[:max(0, limit)]


def safe_registry_warning(error, refresh=False):
    if isinstance(error, AttributeError):
        field = str(getattr(error, "name", ""))
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field):
            message = f"The installed Hermes provider registry is missing a compatible {field} field."
        else:
            message = "The installed Hermes provider registry is incompatible with this catalog."
    elif isinstance(error, ModuleNotFoundError):
        module = str(getattr(error, "name", ""))
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", module):
            message = f"The installed Hermes environment is missing Python module {module}."
        else:
            message = "A required Hermes Python module could not be loaded."
    else:
        message = "The installed Hermes provider registry could not be loaded."
    message += " Showing saved and cached models only. Run npm run doctor for local compatibility details."
    if refresh:
        message += " Provider refresh is unavailable until the registry loads."
    return message


def local_catalog_fallback(config, cached, voice, warning):
    """Build a read-only catalog from saved selections and the on-disk provider cache."""
    model_cfg = config.get("model") or {}
    if not isinstance(model_cfg, dict):
        model_cfg = {"default": str(model_cfg)}
    fallback = config.get("fallback_model") or {}
    if not isinstance(fallback, dict):
        fallback = {}
    current = {
        "provider": str(model_cfg.get("provider") or ""),
        "model": str(model_cfg.get("default") or ""),
        "fallback": {"provider": str(fallback.get("provider") or ""), "model": str(fallback.get("model") or "")},
    }
    voice = voice if isinstance(voice, dict) else {}
    voice_selection = {"provider": str(voice.get("provider") or ""), "model": str(voice.get("model") or "")}
    selections = [current, current["fallback"], voice_selection]
    ids = set(cached) if isinstance(cached, dict) else set()
    ids.update(selection["provider"] for selection in selections if selection["provider"])
    rows = []
    for slug in sorted(value for value in ids if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,120}", value)):
        entry = cached.get(slug, {}) if isinstance(cached, dict) else {}
        cached_ids = model_ids(entry.get("models")) if isinstance(entry, dict) else []
        models = [{"id": model, "label": model, "source": "hermes-cache", "availability": "unverified"} for model in cached_ids if valid_model(model)]
        for selection in selections:
            model = selection["model"] if selection["provider"] == slug else ""
            if model and all(item["id"] != model for item in models):
                models.insert(0, selection_model(model, slug, listed=False))
        labels = {"openai-api": "OpenAI", "openai-codex": "OpenAI Codex", "xai": "xAI", "nvidia": "NVIDIA", "ollama": "Ollama", "lmstudio": "LM Studio", "copilot-acp": "GitHub Copilot"}
        rows.append({
            "id": slug, "label": labels.get(slug, slug.replace("-", " ").title()), "configured": False,
            "savedLocally": slug in {selection["provider"] for selection in selections}, "authType": "",
            "canUseForVoice": False, "supportsCatalog": False, "supportsCustomModel": False, "supportsProbe": False,
            "catalogStatus": "cached" if cached_ids else "local", "catalogError": "Registry unavailable; this view is read-only.",
            "models": models, "source": "Hermes local configuration", "modelCount": len(models),
        })
    return {"ok": True, "degraded": True, "warning": warning, "registryStatus": "unavailable", "current": current, "voice": {**voice_selection, "usesDefault": not voice_selection["model"]}, "providers": rows, "credentialEnvVars": sorted(config_environment_names(config)), "credentialConfigRevision": connection_config_revision(config)}


def apply_model_assignment(config, provider, model, role, base_url=""):
    """Preserve unrelated model/runtime settings; never reuse another provider's inline key."""
    if not valid_model(model):
        raise ValueError("Enter a model ID without spaces, up to 200 characters.")
    if role not in {"primary", "fallback"}:
        raise ValueError("Role must be primary or fallback.")
    result = copy.deepcopy(config)
    key = "model" if role == "primary" else "fallback_model"
    block = result.get(key) if isinstance(result.get(key), dict) else {}
    if block.get("provider") != provider:
        for field in ("api_key", "api_key_env", "key_env", "api_mode", "base_url", "extra_headers"):
            block.pop(field, None)
    block["provider"] = provider
    block["default" if role == "primary" else "model"] = model
    if base_url:
        block["base_url"] = base_url
    result[key] = block
    return result


def atomic_config_write(file, config):
    import yaml
    original = file.read_text()
    backup = file.with_suffix(file.suffix + ".control-center.bak")
    if not backup.exists():
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(original)
    descriptor, temporary = tempfile.mkstemp(prefix=".control-model-", dir=file.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            yaml.safe_dump(config, handle, sort_keys=False, allow_unicode=True)
        os.chmod(temporary, file.stat().st_mode & 0o777)
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def model_assignment_lock(file, timeout=2.0):
    """Bounded process lock; the OS releases it if a catalog process exits."""
    import time
    try:
        import fcntl
    except ImportError:
        raise ValueError("Model changes require a macOS or Linux filesystem lock.")
    descriptor = os.open(str(file) + ".control-center.lock", os.O_WRONLY | os.O_CREAT, 0o600)
    locked = False
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("Another model change is being saved. Try again in a moment.")
                time.sleep(0.02)
        yield
    finally:
        if locked:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def save_model_assignment(file, provider, model, role, base_url="", lock_timeout=2.0):
    """Read and mutate the latest config inside the same assignment transaction."""
    import yaml
    with model_assignment_lock(file, lock_timeout):
        latest, warning = read_config(file, yaml)
        if warning:
            raise ValueError("Hermes configuration cannot be saved until it can be read. Run hermes setup or npm run doctor.")
        next_config = apply_model_assignment(latest, provider, model, role, base_url)
        atomic_config_write(file, next_config)
        return next_config


def main(request):
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    repo = Path(os.environ.get("HERMES_REPO", home / "hermes-agent"))
    sys.path.insert(0, str(repo))
    import yaml
    from dotenv import load_dotenv, dotenv_values
    load_dotenv(home / ".env", override=False)
    # Match Hermes API-key precedence without invoking its network-capable
    # resolvers. Saved dotenv values win over stale inherited shell exports.
    credential_environment = {**os.environ, **{key: value for key, value in dotenv_values(home / ".env").items() if value}}
    config_file = home / "config.yaml"
    config, config_warning = read_config(config_file, yaml)
    model_cfg = config.get("model") or {}
    if not isinstance(model_cfg, dict):
        model_cfg = {"default": str(model_cfg)}
    current = {"provider": str(model_cfg.get("provider") or ""), "model": str(model_cfg.get("default") or ""), "fallback": config.get("fallback_model") or {}}
    # Only selection identifiers leave the bridge, never arbitrary config fields.
    fallback = current["fallback"] if isinstance(current["fallback"], dict) else {}
    current["fallback"] = {"provider": str(fallback.get("provider") or ""), "model": str(fallback.get("model") or "")}
    voice = request.get("voice") if isinstance(request.get("voice"), dict) else {}
    selections = [current, current["fallback"], {"provider": str(voice.get("provider") or ""), "model": str(voice.get("model") or "")}]
    cached = read_json(home / "provider_models_cache.json")
    action = request.get("action", "catalog")
    try:
        from hermes_cli.provider_catalog import provider_catalog
        from hermes_cli.auth import PROVIDER_REGISTRY, resolve_api_key_provider_credentials
        from hermes_cli.providers import get_provider, custom_provider_slug
        from hermes_cli.models_catalog_static import _PROVIDER_MODELS
        descriptors = provider_catalog()
    except Exception as error:
        if action != "catalog":
            raise ValueError("Hermes provider definitions could not be loaded. Run npm run doctor for local compatibility details.")
        return local_catalog_fallback(config, cached, voice, safe_registry_warning(error, bool(request.get("refresh"))))
    if config_warning and action != "catalog":
        raise ValueError("Hermes configuration cannot be saved until it can be read. Run hermes setup or npm run doctor.")

    auth_store = read_json(home / "auth.json")
    credential_pool = auth_store.get("credential_pool") or {}
    rows = []
    connections = {}
    definitions = {}
    credential_env_names = config_environment_names(config)
    for descriptor in descriptors:
        slug = descriptor.slug
        if descriptor.auth_type == "virtual":
            continue
        registry = PROVIDER_REGISTRY.get(slug)
        pdef = get_provider(slug, allow_network=False)
        provider_states = auth_store.get("providers") or {}
        auth = provider_states.get(slug, {}) if isinstance(provider_states, dict) else {}
        env_names = getattr(descriptor, "api_key_env_vars", ())
        credential_env_names.update(str(name) for name in env_names)
        base_var = str(getattr(descriptor, "base_url_env_var", "") or "")
        if base_var:
            credential_env_names.add(base_var)
        credential_env_names.update(str(name) for name in getattr(pdef, "api_key_env_vars", ()) or ())
        local_key_present = any(str(credential_environment.get(str(name), "")).strip() for name in env_names)
        if slug == current["provider"]:
            key_env = str(model_cfg.get("key_env") or model_cfg.get("api_key_env") or "")
            local_key_present = local_key_present or bool(model_cfg.get("api_key")) or bool(key_env and str(credential_environment.get(key_env, "")).strip())
        pooled = bool(credential_pool.get(slug)) if isinstance(credential_pool, dict) else False
        entry = cached.get(slug, {})
        cached_ids = model_ids(entry.get("models")) if isinstance(entry, dict) else []
        configured = provider_is_configured(auth if isinstance(auth, dict) else {}, descriptor, pooled, local_key_present)
        # Saved selections and existing local provider catalogs stay visible without credentials.
        if not configured and slug not in {selection["provider"] for selection in selections} and not cached_ids:
            continue
        transport = pdef.transport if pdef else ""
        if slug == current["provider"] and model_cfg.get("api_mode"):
            transport = str(model_cfg["api_mode"])
        base = str((os.getenv(base_var, "") if base_var else "") or (registry.inference_base_url if registry else "") or (pdef.base_url if pdef else ""))
        if slug == current["provider"] and model_cfg.get("base_url"):
            base = str(model_cfg["base_url"])
        hosted_nvidia = base.rstrip("/") == "https://integrate.api.nvidia.com/v1"
        curated = model_ids(_PROVIDER_MODELS.get(slug, []))
        source = "hermes-cache" if cached_ids else "hermes-catalog"
        ids = cached_ids or curated
        catalog_note = ""
        if slug == "nvidia":
            ids = nvidia_chat_models(ids, hosted_nvidia)
            catalog_note = "Discovery IDs, not verified access. Known non-chat services and documented hosted deprecations are hidden; other endpoints may also be unavailable."
        supports_probe = provider_supports_probe(slug, descriptor.auth_type, transport, configured, base)
        rows.append({"id": slug, "label": descriptor.label, "configured": configured, "savedLocally": slug in {selection["provider"] for selection in selections}, "authType": descriptor.auth_type, "canUseForVoice": configured, "supportsCatalog": configured and descriptor.auth_type == "api_key", "supportsCustomModel": descriptor.auth_type not in {"external_process", "oauth_external", "oauth_device_code"}, "supportsProbe": supports_probe, "catalogStatus": "cached" if cached_ids else "local", **({"catalogNote": catalog_note} if catalog_note else {}), "models": [{"id": model, "label": model, "source": source, "availability": "unverified"} for model in ids], "source": "Hermes setup"})
        definition_env_names = set(str(name) for name in env_names) | set(str(name) for name in getattr(pdef, "api_key_env_vars", ()) or ())
        if base_var:
            definition_env_names.add(base_var)
        definitions[slug] = {"baseUrl": base, "transport": transport, "registry": True, "hostedNvidia": hosted_nvidia, "credentialEnvVars": sorted(definition_env_names), "directVoice": configured and descriptor.auth_type == "api_key" and transport in {"openai_chat", "chat_completions"} and bool(base)}

    custom = list(config.get("custom_providers") or [])
    for name, entry in (config.get("providers") or {}).items():
        if isinstance(entry, dict) and entry.get("enabled") is not False:
            custom.append({"name": name, **entry})
    if current["provider"] in {"custom", "local", "ollama"} and model_cfg.get("base_url"):
        custom.append({"name": current["provider"], **model_cfg, "model": current["model"]})
    for entry in custom:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or entry.get("provider") or "custom")
        slug = name if name in {"custom", "local", "ollama"} else custom_provider_slug(name)
        base = str(entry.get("base_url") or entry.get("url") or "")
        if not base:
            continue
        key_env = str(entry.get("key_env") or entry.get("api_key_env") or "")
        key = str(entry.get("api_key") or credential_environment.get(key_env, ""))
        mode = str(entry.get("api_mode") or entry.get("transport") or "chat_completions")
        configured = bool(key or base.startswith(("http://localhost", "http://127.0.0.1", "http://[::1]")) or entry.get("key_cmd"))
        ids = model_ids(entry.get("models"))
        if entry.get("model"):
            ids.insert(0, str(entry["model"]))
        rows = [row for row in rows if row["id"] != slug]
        supports_probe = provider_supports_probe(slug, "custom", mode, configured, base, entry.get("key_cmd"))
        rows.append({"id": slug, "label": name, "configured": configured, "authType": "custom", "canUseForVoice": configured, "supportsCatalog": configured and not entry.get("key_cmd"), "supportsCustomModel": True, "supportsProbe": supports_probe, "catalogStatus": "local", "models": [{"id": model, "label": model, "source": "hermes-config", "availability": "unverified"} for model in ids], "source": "Hermes setup"})
        definitions[slug] = {"baseUrl": base, "transport": mode, "entry": entry, "directVoice": configured and mode in {"chat_completions", "openai_chat"} and not entry.get("key_cmd")}
        connections[slug] = {"provider": slug, "api_key": key or "local", "base_url": base, "source": key_env or "Hermes provider config"}

    for selection in selections:
        row = next((row for row in rows if row["id"] == selection["provider"]), None)
        if row and selection["model"] and all(model["id"] != selection["model"] for model in row["models"]):
            row["models"].insert(0, selection_model(selection["model"], row["id"], definitions[row["id"]].get("hostedNvidia", False)))

    def connection(slug):
        if slug in connections:
            return connections[slug]
        value = resolve_api_key_provider_credentials(slug)
        # Preserve the selected provider's explicit endpoint, matching Hermes.
        if slug == current["provider"] and model_cfg.get("base_url"):
            value["base_url"] = model_cfg["base_url"]
        return value

    if action in {"switch", "resolve", "validate", "resolve_probe"}:
        provider = str(request.get("provider") or "")
        row = next((row for row in rows if row["id"] == provider), None)
        if not row or not row["configured"]:
            raise ValueError("This provider is not configured in Hermes. Connect it with hermes model first.")
        model = str(request.get("model") or "")
        if not valid_model(model):
            raise ValueError("Enter a valid model ID, up to 200 characters without spaces.")
        if provider == "nvidia":
            status = nvidia_model_status(model, definitions[provider].get("hostedNvidia", False))
            if status.get("available") is False:
                raise ValueError(status["availabilityNote"])
        if not row["supportsCustomModel"] and model not in {entry["id"] for entry in row["models"]}:
            raise ValueError("Choose a model from this provider's Hermes catalog.")
        if action == "validate":
            return {"ok": True}
        if action == "resolve_probe":
            if not row.get("supportsProbe"):
                raise ValueError("This provider is tested through Hermes's own runtime. Send it a normal conversation instead.")
            value = connection(provider)
            entry = definitions[provider].get("entry") or (model_cfg if provider == current["provider"] else {})
            if entry.get("api_key"):
                value["api_key"] = str(entry["api_key"])
            elif entry.get("key_env") or entry.get("api_key_env"):
                value["api_key"] = str(credential_environment.get(str(entry.get("key_env") or entry.get("api_key_env")), ""))
            headers = entry.get("extra_headers") or {}
            headers = {str(key): str(value) for key, value in headers.items()} if isinstance(headers, dict) else {}
            return {"ok": True, "provider": provider, "model": model, "baseUrl": value["base_url"], "apiKey": value["api_key"], "protocol": definitions[provider]["transport"], "extraHeaders": headers, "tokenLimitParameter": probe_token_limit_parameter(model, value["base_url"]), "credentialRevision": provider_credential_revision(provider, config, definitions[provider], auth_store, credential_environment)}
        if action == "resolve":
            if not definitions[provider].get("directVoice"):
                raise ValueError("This provider's protocol is not supported by direct voice replies. Use it for the Hermes agent.")
            value = connection(provider)
            return {"provider": provider, "model": model, "baseUrl": value["base_url"], "apiKey": value["api_key"], "envKey": value.get("source") or "Hermes credentials"}
        definition = definitions[provider]
        save_model_assignment(config_file, provider, model, request.get("role", "primary"), definition["baseUrl"])
        return {"ok": True, "option": {"id": f"{provider}:{model}", "provider": provider, "model": model, "label": model}, "message": "Saved to Hermes configuration. New sessions use this model."}

    if request.get("refresh"):
        from concurrent.futures import ThreadPoolExecutor
        from hermes_cli.models import fetch_api_models, update_provider_cache_entry
        selected = request.get("provider")
        eligible = [row for row in rows if row["supportsCatalog"] and (not selected or row["id"] == selected)]
        targets = select_refresh_targets(rows, selected or "")
        target_ids = {row["id"] for row in targets}
        for row in eligible:
            if row["id"] not in target_ids:
                row["catalogStatus"] = "refresh-limited"
                row["catalogError"] = "Refresh is limited to four provider catalogs per request. Select this provider to refresh it directly."
        def refresh_row(row):
            try:
                value = connection(row["id"])
                mode = definitions[row["id"]]["transport"]
                mode = "anthropic_messages" if mode == "anthropic_messages" else None
                ids = fetch_api_models(value["api_key"], value["base_url"], timeout=5, api_mode=mode)
                if ids is None:
                    raise ValueError("Catalog unavailable")
                # Persist the actual discovery IDs using Hermes' own cache writer.
                # Filtering belongs to this picker, not the shared provider cache.
                if definitions[row["id"]].get("registry"):
                    update_provider_cache_entry(row["id"], ids)
                if row["id"] == "nvidia":
                    ids = nvidia_chat_models(ids, definitions[row["id"]].get("hostedNvidia", False))
                row["models"] = [{"id": model, "label": model, "source": "provider-catalog", "availability": "unverified"} for model in ids]
                # Current selection remains visible even when a partial catalog omits it.
                for selection in selections:
                    if selection["provider"] == row["id"] and selection["model"] not in ids and selection["model"]:
                        row["models"].insert(0, selection_model(selection["model"], row["id"], definitions[row["id"]].get("hostedNvidia", False)))
                row["catalogStatus"] = "provider-listed"
            except Exception:
                row["catalogStatus"] = "unavailable"
                row["catalogError"] = "Could not refresh this provider's catalog. Saved Hermes models are still shown."
        if targets:
            with ThreadPoolExecutor(max_workers=min(4, len(targets))) as pool:
                list(pool.map(refresh_row, targets))
    for row in rows:
        seen = set()
        row["models"] = [model for model in row["models"] if valid_model(model["id"]) and not (model["id"] in seen or seen.add(model["id"]))]
        row["modelCount"] = len(row["models"])
    result = {"ok": True, "current": current, "providers": rows, "credentialEnvVars": sorted(credential_env_names), "credentialConfigRevision": connection_config_revision(config, definitions), "providerCredentialRevisions": {row["id"]: provider_credential_revision(row["id"], config, definitions[row["id"]], auth_store, credential_environment) for row in rows if row.get("supportsProbe")}}
    if config_warning:
        result.update({"degraded": True, "warning": config_warning})
    return result


if __name__ == "__main__":
    request = json.loads(sys.stdin.read() or "{}")
    try:
        # Third-party import/status diagnostics must not corrupt the JSON channel.
        with contextlib.redirect_stdout(sys.stderr):
            result = main(request)
        print(json.dumps(result))
    except Exception as error:
        if isinstance(error, ValueError):
            message = str(error)
        elif isinstance(error, AttributeError) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(getattr(error, "name", ""))):
            message = f"The installed Hermes model registry is missing a compatible {error.name} field. Run npm run doctor for local compatibility details."
        elif isinstance(error, ModuleNotFoundError) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", str(getattr(error, "name", ""))):
            message = f"The installed Hermes model environment is missing Python module {error.name}. Run npm run doctor for local compatibility details."
        else:
            message = "Hermes model setup could not be read. Run npm run doctor for local compatibility details."
        print(json.dumps({"ok": False, "error": message}))
        sys.exit(1)
