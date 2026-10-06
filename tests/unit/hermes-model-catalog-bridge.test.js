import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const bridgePath = "scripts/models/hermes-catalog.py";

function runBridgeHelpers(program) {
  const output = execFileSync("python3", ["-c", `import importlib.util, sys\nspec = importlib.util.spec_from_file_location("catalog", sys.argv[1])\ncatalog = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(catalog)\n${program}`, bridgePath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

test("provider descriptors without the optional keyless field remain compatible", () => {
  const data = runBridgeHelpers(`from types import SimpleNamespace
descriptor = SimpleNamespace(slug="provider", label="Provider", auth_type="api_key")
assert catalog.provider_is_configured({"configured": True}, descriptor) is True
assert catalog.provider_is_configured({}, descriptor) is False
assert catalog.provider_is_configured({}, SimpleNamespace(keyless=True)) is True
print(__import__("json").dumps({"ok": True}))`);
  assert.equal(data.ok, true);
});

test("provider refresh is capped and a specific provider gets a targeted refresh", () => {
  const data = runBridgeHelpers(`import json
rows = [{"id": f"provider-{number}", "supportsCatalog": True} for number in range(8)]
print(json.dumps({
    "all": [row["id"] for row in catalog.select_refresh_targets(rows)],
    "targeted": [row["id"] for row in catalog.select_refresh_targets(rows, "provider-6")],
}))`);
  assert.equal(data.all.length, 4);
  assert.deepEqual(data.targeted, ["provider-6"]);
});

test("direct tests support ordinary API transports and exclude model-dependent native routing", () => {
  const data = runBridgeHelpers(`import json
assert catalog.provider_supports_probe("openai-api", "api_key", "codex_responses", True, "https://configured.invalid/v1")
assert catalog.provider_supports_probe("anthropic", "api_key", "anthropic_messages", True, "https://configured.invalid/v1")
assert not catalog.provider_supports_probe("copilot", "api_key", "openai_chat", True, "https://configured.invalid/v1")
assert not catalog.provider_supports_probe("oauth", "oauth_external", "openai_chat", True, "https://configured.invalid/v1")
assert not catalog.provider_supports_probe("custom", "custom", "openai_chat", True, "https://configured.invalid/v1", True)
assert not catalog.provider_supports_probe("missing", "api_key", "openai_chat", False, "https://configured.invalid/v1")
print(json.dumps({"ok": True}))`);
  assert.equal(data.ok, true);
});

test("chat probes reuse Hermes token-limit compatibility and match native endpoint hosts exactly", () => {
  const data = runBridgeHelpers(`import json, types
helper = types.ModuleType("utils")
helper.model_forces_max_completion_tokens = lambda model: model in {"o3", "vendor/custom-reasoner"}
sys.modules["utils"] = helper
assert catalog.probe_token_limit_parameter("o3", "https://proxy.invalid/v1") == "max_completion_tokens"
assert catalog.probe_token_limit_parameter("vendor/custom-reasoner", "https://proxy.invalid/v1") == "max_completion_tokens"
assert catalog.probe_token_limit_parameter("any", "https://api.openai.com/v1") == "max_completion_tokens"
assert catalog.probe_token_limit_parameter("any", "https://tenant.openai.azure.com/v1") == "max_completion_tokens"
for host in ["https://api.deepseek.com/v1", "https://api.openai.com.invalid/v1", "https://proxy.invalid/api.openai.com/v1"]:
    assert catalog.probe_token_limit_parameter("deepseek-flash", host) == "max_tokens"
print(json.dumps({"ok": True}))`);
  assert.equal(data.ok, true);
});

test("custom connection environment references are collected without exposing values", () => {
  const data = runBridgeHelpers(`import json
config = {"model": {"key_env": "WIZARD", "api_key": "private-value"}, "providers": {"test": {"api_key_env_vars": ["ODD_NAME", "OTHER"], "base_url": "https://host/$REGION_NAME", "extra_headers": {"x-test": "\u0024{env:STRANGE_HEADER}"}}}, "other": {"secret_env": "PRIVATE_ACCOUNT"}}
names = catalog.config_environment_names(config)
assert names == {"WIZARD", "ODD_NAME", "OTHER", "REGION_NAME", "STRANGE_HEADER", "PRIVATE_ACCOUNT"}
assert "private-value" not in names
print(json.dumps({"count": len(names)}))`);
  assert.equal(data.count, 6);
});

test("connection fingerprints preserve test evidence across assignments but detect keys, endpoints and accounts", () => {
  const data = runBridgeHelpers(`import copy, json
definitions = {"first": {"baseUrl": "https://first.invalid/v1", "transport": "openai_chat"}, "second": {"baseUrl": "https://second.invalid/v1", "transport": "openai_chat"}}
config = {"model": {"provider": "first", "default": "model-a", "base_url": "https://first.invalid/v1"}, "fallback_model": {"provider": "second", "model": "model-b"}, "agent": {"max_turns": 10}, "providers": {"custom": {"base_url": "https://custom.invalid/v1", "api_key": "same-key", "account_id": "same-account", "extra_headers": {"x-private": "same-header"}, "models": ["listed-a"]}}}
revision = catalog.connection_config_revision(config, definitions)
main_changed = catalog.apply_model_assignment(config, "first", "new-main", "primary", "https://first.invalid/v1")
both_changed = catalog.apply_model_assignment(main_changed, "second", "new-backup", "fallback", "https://second.invalid/v1")
assert catalog.connection_config_revision(both_changed, definitions) == revision
other_changed = copy.deepcopy(both_changed)
other_changed["agent"]["max_turns"] = 100
other_changed["providers"]["custom"]["models"] = ["listed-b", "new-id"]
assert catalog.connection_config_revision(other_changed, definitions) == revision
for field, value in [("api_key", "new-key"), ("api_key_env", "ANOTHER_CUSTOM_NAME"), ("base_url", "https://different.invalid/v1"), ("account_id", "new-account"), ("extra_headers", {"x-private": "new-header"})]:
    changed = copy.deepcopy(config)
    changed["providers"]["custom"][field] = value
    assert catalog.connection_config_revision(changed, definitions) != revision, field
inline = copy.deepcopy(config)
inline["model"]["api_key"] = "inline-key"
assert catalog.connection_config_revision(inline, definitions) != revision
endpoint_changed = copy.deepcopy(definitions)
endpoint_changed["first"]["baseUrl"] = "https://another.invalid/v1"
assert catalog.connection_config_revision(config, endpoint_changed) != revision
assert "same-key" not in revision
print(json.dumps({"assignmentsPreserved": True, "connectionChangesDetected": True}))`);
  assert.equal(data.assignmentsPreserved, true);
  assert.equal(data.connectionChangesDetected, true);
});

test("per-provider fingerprints ignore auth bookkeeping and other accounts while tracking their connection material", () => {
  const data = runBridgeHelpers(`import copy, json
config = {"model": {"provider": "deepseek", "default": "main", "base_url": "https://deepseek.invalid/v1"}, "fallback_model": {"provider": "deepseek", "model": "backup"}, "agent": {"max_turns": 10}}
definition = {"baseUrl": "https://deepseek.invalid/v1", "transport": "openai_chat", "credentialEnvVars": ["DEEPSEEK_API_KEY"]}
auth = {"updated_at": "before", "active_provider": "deepseek", "providers": {"deepseek": {"account_id": "account-a"}, "other": {"access_token": "other-token-a"}}, "credential_pool": {"deepseek": [{"id": "same-account", "source": "env:DEEPSEEK_API_KEY", "priority": 1, "secret_fingerprint": "key-a", "base_url": "https://deepseek.invalid/v1", "request_count": 1, "last_status": "ok", "last_status_at": "before", "label": "Displayed label"}], "other": [{"access_token": "another-token-a"}]}}
environment = {"DEEPSEEK_API_KEY": "same-key", "OTHER_API_KEY": "other-key-a", "HERMES_BUILD_ID": "build-a", "PORT": "3014"}
revision = catalog.provider_credential_revision("deepseek", config, definition, auth, environment)
bookkeeping = copy.deepcopy(auth)
bookkeeping["updated_at"] = "after"
bookkeeping["active_provider"] = "other"
bookkeeping["providers"]["other"]["access_token"] = "other-token-b"
bookkeeping["credential_pool"]["other"][0]["access_token"] = "another-token-b"
bookkeeping["credential_pool"]["deepseek"][0].update({"request_count": 999, "last_status": "ok", "last_status_at": "after", "last_error_message": "New unrelated status text", "label": "Another display label"})
restarted = {**environment, "OTHER_API_KEY": "other-key-b", "HERMES_BUILD_ID": "build-b", "PORT": "3000"}
assert catalog.provider_credential_revision("deepseek", config, definition, bookkeeping, restarted) == revision
assignment = catalog.apply_model_assignment(config, "deepseek", "new-model", "primary", definition["baseUrl"])
assert catalog.provider_credential_revision("deepseek", assignment, definition, bookkeeping, restarted) == revision
for field, value in [("secret_fingerprint", "key-b"), ("base_url", "https://another.invalid/v1"), ("priority", 5)]:
    changed = copy.deepcopy(auth)
    changed["credential_pool"]["deepseek"][0][field] = value
    assert catalog.provider_credential_revision("deepseek", config, definition, changed, environment) != revision, field
account_changed = copy.deepcopy(auth)
account_changed["providers"]["deepseek"]["account_id"] = "account-b"
assert catalog.provider_credential_revision("deepseek", config, definition, account_changed, environment) != revision
assert catalog.provider_credential_revision("deepseek", config, definition, auth, {**environment, "DEEPSEEK_API_KEY": "new-key"}) != revision
endpoint_changed = {**definition, "baseUrl": "https://different.invalid/v1"}
assert catalog.provider_credential_revision("deepseek", config, endpoint_changed, auth, environment) != revision
assert "same-key" not in revision
print(json.dumps({"retainedAcrossBookkeepingAndRestart": True, "providerChangesInvalidate": True}))`);
  assert.equal(data.retainedAcrossBookkeepingAndRestart, true);
  assert.equal(data.providerChangesInvalidate, true);
});

test("custom probe credentials and fingerprints share Hermes saved-dotenv precedence", () => {
  const data = runBridgeHelpers(`import json, os, pathlib, tempfile, types
yaml = types.ModuleType("yaml")
yaml.safe_load = json.loads
sys.modules["yaml"] = yaml
dotenv = types.ModuleType("dotenv")
dotenv.load_dotenv = lambda *args, **kwargs: None
dotenv.dotenv_values = lambda file: json.loads(pathlib.Path(file).read_text())
sys.modules["dotenv"] = dotenv
for name in ["hermes_cli", "hermes_cli.provider_catalog", "hermes_cli.auth", "hermes_cli.providers", "hermes_cli.models_catalog_static"]:
    sys.modules[name] = types.ModuleType(name)
sys.modules["hermes_cli.provider_catalog"].provider_catalog = lambda: []
sys.modules["hermes_cli.auth"].PROVIDER_REGISTRY = {}
sys.modules["hermes_cli.auth"].resolve_api_key_provider_credentials = lambda name: (_ for _ in ()).throw(AssertionError("Custom connections must remain local"))
sys.modules["hermes_cli.providers"].get_provider = lambda *args, **kwargs: None
sys.modules["hermes_cli.providers"].custom_provider_slug = lambda name: "custom-" + name
sys.modules["hermes_cli.models_catalog_static"]._PROVIDER_MODELS = {}
with tempfile.TemporaryDirectory(prefix="panel-custom-key-precedence-") as directory:
    home = pathlib.Path(directory)
    os.environ["HERMES_HOME"] = directory
    os.environ["HERMES_REPO"] = directory
    os.environ["CUSTOM_FIXTURE_KEY"] = "stale-inherited-key"
    config = {"model": {"provider": "local", "default": "fixture-model", "base_url": "https://configured.invalid/v1", "key_env": "CUSTOM_FIXTURE_KEY"}, "custom_providers": [{"name": "studio", "model": "fixture-model", "base_url": "https://configured.invalid/v1", "key_env": "CUSTOM_FIXTURE_KEY"}]}
    (home / "config.yaml").write_text(json.dumps(config))
    (home / ".env").write_text(json.dumps({"CUSTOM_FIXTURE_KEY": "saved-key-a"}))
    request = {"action": "resolve_probe", "provider": "custom-studio", "model": "fixture-model"}
    first = catalog.main(request)
    assert first["apiKey"] == "saved-key-a"
    assert catalog.main({"action": "resolve_probe", "provider": "local", "model": "fixture-model"})["apiKey"] == "saved-key-a"
    assert first["credentialRevision"] == catalog.main({})["providerCredentialRevisions"]["custom-studio"]
    os.environ["CUSTOM_FIXTURE_KEY"] = "another-stale-inherited-key"
    assert catalog.main(request)["credentialRevision"] == first["credentialRevision"]
    assert catalog.main(request)["apiKey"] == "saved-key-a"
    (home / ".env").write_text(json.dumps({"CUSTOM_FIXTURE_KEY": "saved-key-b"}))
    changed = catalog.main(request)
    assert changed["apiKey"] == "saved-key-b"
    assert changed["credentialRevision"] != first["credentialRevision"]
    (home / ".env").write_text(json.dumps({"CUSTOM_FIXTURE_KEY": ""}))
    inherited = catalog.main(request)
    assert inherited["apiKey"] == "another-stale-inherited-key"
    os.environ["CUSTOM_FIXTURE_KEY"] = "new-inherited-key"
    assert catalog.main(request)["apiKey"] == "new-inherited-key"
    assert catalog.main(request)["credentialRevision"] != inherited["credentialRevision"]
    print(json.dumps({"resolvedSavedKey": True, "matchedFingerprint": True, "emptySavedUsesInherited": True}))`);
  assert.deepEqual(data, { resolvedSavedKey: true, matchedFingerprint: true, emptySavedUsesInherited: true });
});

test("concurrent main and backup assignments preserve both roles and unrelated settings", () => {
  const data = runBridgeHelpers(`import json, subprocess, tempfile, time, pathlib
child = r'''import importlib.util, json, pathlib, sys, time, types
spec = importlib.util.spec_from_file_location("catalog", sys.argv[1])
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
# JSON is a valid YAML subset; use a minimal parser so this concurrency test
# does not depend on a global Python installation having Hermes's PyYAML.
yaml = types.ModuleType("yaml")
yaml.safe_load = json.loads
yaml.safe_dump = lambda value, handle=None, **kwargs: handle.write(json.dumps(value)) if handle is not None else json.dumps(value)
sys.modules["yaml"] = yaml
file = pathlib.Path(sys.argv[2])
mode = sys.argv[3]
initial, warning = catalog.read_config(file, yaml)
assert not warning and initial["model"]["default"] == "old-main"
if mode == "main":
    original_write = catalog.atomic_config_write
    def delayed_write(target, value):
        (file.parent / "main-locked").write_text("ready")
        deadline = time.monotonic() + 5
        while not (file.parent / "release-main").exists():
            assert time.monotonic() < deadline
            time.sleep(0.005)
        original_write(target, value)
    catalog.atomic_config_write = delayed_write
    catalog.save_model_assignment(file, "same-provider", "new-main", "primary", "https://main.invalid/v1")
else:
    # This read is deliberately stale while the other mutation is paused.
    (file.parent / "backup-read-old").write_text("ready")
    catalog.save_model_assignment(file, "same-provider", "new-backup", "fallback", "https://backup.invalid/v1")
'''
with tempfile.TemporaryDirectory(prefix="panel-model-concurrency-") as directory:
    root = pathlib.Path(directory)
    file = root / "config.yaml"
    initial = {"model": {"provider": "same-provider", "default": "old-main", "api_key": "fixture-main-key", "context_length": 42000}, "fallback_model": {"provider": "same-provider", "model": "old-backup", "api_key": "fixture-backup-key"}, "agent": {"max_turns": 14}, "custom_providers": [{"name": "untouched", "base_url": "http://localhost:1234/v1"}]}
    file.write_text(json.dumps(initial))
    processes = []
    def start(mode):
        process = subprocess.Popen([sys.executable, "-c", child, str(pathlib.Path(sys.argv[1]).resolve()), str(file), mode], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(process)
        return process
    def wait_for(name):
        deadline = time.monotonic() + 5
        while not (root / name).exists():
            assert time.monotonic() < deadline, name
            time.sleep(0.005)
    try:
        main = start("main")
        wait_for("main-locked")
        backup = start("backup")
        wait_for("backup-read-old")
        (root / "release-main").write_text("go")
        for process in processes:
            stdout, stderr = process.communicate(timeout=7)
            assert process.returncode == 0, stderr
        final = json.loads(file.read_text())
        assert final["model"]["default"] == "new-main"
        assert final["fallback_model"]["model"] == "new-backup"
        assert final["model"]["api_key"] == initial["model"]["api_key"]
        assert final["fallback_model"]["api_key"] == initial["fallback_model"]["api_key"]
        assert final["model"]["context_length"] == 42000
        assert final["agent"] == initial["agent"]
        assert final["custom_providers"] == initial["custom_providers"]
        assert json.loads(file.with_suffix(".yaml.control-center.bak").read_text()) == initial
        print(json.dumps({"rolesPreserved": 2, "unrelatedSettingsPreserved": True}))
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)`);
  assert.equal(data.rolesPreserved, 2);
  assert.equal(data.unrelatedSettingsPreserved, true);
});

test("a busy model assignment fails within its deadline and leaves the config unchanged", () => {
  const data = runBridgeHelpers(`import json, pathlib, tempfile, time, types
yaml = types.ModuleType("yaml")
yaml.safe_load = json.loads
yaml.safe_dump = lambda value, handle=None, **kwargs: handle.write(json.dumps(value)) if handle is not None else json.dumps(value)
sys.modules["yaml"] = yaml
with tempfile.TemporaryDirectory(prefix="panel-model-lock-") as directory:
    file = pathlib.Path(directory) / "config.yaml"
    original = json.dumps({"model": {"provider": "same-provider", "default": "saved"}})
    file.write_text(original)
    with catalog.model_assignment_lock(file):
        started = time.monotonic()
        try:
            catalog.save_model_assignment(file, "same-provider", "new", "primary", lock_timeout=0.05)
            raise AssertionError("The competing mutation must not acquire the held lock")
        except ValueError as error:
            assert str(error) == "Another model change is being saved. Try again in a moment."
            assert time.monotonic() - started < 0.3
    assert file.read_text() == original
    assert not file.with_suffix(".yaml.control-center.bak").exists()
    print(json.dumps({"bounded": True, "unchanged": True}))`);
  assert.equal(data.bounded, true);
  assert.equal(data.unchanged, true);
});

test("local catalog fallback preserves cached and saved models without importing Hermes auth", () => {
  const data = runBridgeHelpers(`import json, sys
partial = catalog.local_catalog_fallback(
    {"model": {"provider": "deepseek"}},
    {"deepseek": {"models": ["cached-model"]}},
    {"provider": "deepseek", "model": "saved-voice-model"},
    "Hermes provider definitions are unavailable.",
)
assert "hermes_cli.auth" not in sys.modules
row = next(item for item in partial["providers"] if item["id"] == "deepseek")
assert partial["degraded"] is True
assert partial["current"]["provider"] == "deepseek"
assert partial["current"]["model"] == ""
assert row["savedLocally"] is True
assert {model["id"] for model in row["models"]} == {"cached-model", "saved-voice-model"}
assert row["configured"] is False
assert row["supportsCustomModel"] is False
empty_config, missing_warning = catalog.read_config(__import__("pathlib").Path("/definitely/missing/hermes-config.yaml"), None)
fresh = catalog.local_catalog_fallback(empty_config, {"deepseek": {"models": ["cached-model"]}}, {}, missing_warning)
assert fresh["degraded"] is True and fresh["providers"]
print(json.dumps({"partialProviderCount": len(partial["providers"]), "freshProviderCount": len(fresh["providers"]), "registryStatus": partial["registryStatus"]}))`);
  assert.equal(data.partialProviderCount, 1);
  assert.equal(data.freshProviderCount, 1);
  assert.equal(data.registryStatus, "unavailable");
});
