import test from "node:test";
import assert from "node:assert/strict";
import { catalogModels, filterCatalogModels, currentModelForRole, isCurrentModel, modelSourceLabel, modelAvailabilityLabel, canAssignCustomModel } from "../../lib/model-catalog-view.js";
import { sanitizeModelCatalog, validateModelSelection } from "../../lib/model-catalog.js";

const catalog = {
  current: { provider: "local", model: "same", fallback: { provider: "remote", model: "reasoner" } },
  voice: { provider: "local", model: "voice", usesDefault: false },
  providers: [
    { id: "local", label: "Local models", configured: true, canUseForVoice: true, supportsCustomModel: true, models: [{ id: "same", label: "Local Same", source: "live" }, { id: "voice", source: "config" }] },
    { id: "remote", label: "Remote provider", configured: true, canUseForVoice: false, supportsCustomModel: false, models: [{ id: "same" }, { id: "reasoner" }] },
    { id: "unconfigured", configured: false, canUseForVoice: true, supportsCustomModel: true, models: [{ id: "new-model" }] },
  ],
};

test("catalog identities distinguish providers with the same model ID", () => {
  const models = catalogModels(catalog);
  assert.equal(models.length, 5);
  assert.equal(new Set(models.map((model) => model.key)).size, 5);
  assert.equal(models[4].selectable, false);
});

test("search combines provider/model terms and excludes unconfigured providers by default", () => {
  const models = catalogModels(catalog);
  assert.equal(filterCatalogModels(models).length, 4);
  assert.deepEqual(filterCatalogModels(models, { query: "local same" }).map((model) => model.provider), ["local"]);
  assert.equal(filterCatalogModels(models, { provider: "all" }).length, 5);
});

test("a locally saved model remains visible when provider setup cannot be checked", () => {
  const degraded = { ...catalog, degraded: true, providers: catalog.providers.map((provider) => provider.id === "local" ? { ...provider, configured: false } : provider) };
  const models = catalogModels(degraded);
  const visible = filterCatalogModels(models, { role: "primary" });
  assert.ok(visible.some((model) => model.provider === "local" && model.model === "same"));
  assert.equal(visible.find((model) => model.provider === "local" && model.model === "same").selectable, false);
  assert.equal(models.find((model) => model.provider === "local" && model.model === "voice").selectable, false);
});

test("Talk and Chat support every configured Hermes provider and preserve custom-ID capabilities", () => {
  assert.equal(filterCatalogModels(catalogModels(catalog), { role: "voice" }).length, 4);
  assert.equal(canAssignCustomModel(catalog.providers[0], "voice", "custom"), true);
  assert.equal(canAssignCustomModel(catalog.providers[1], "primary", "custom"), false);
  assert.equal(canAssignCustomModel(catalog.providers[2], "voice", "custom"), false);
  assert.equal(canAssignCustomModel(catalog.providers[0], "voice", "  "), false);
});

test("role assignments preserve follow-primary voice and provider-sensitive selection", () => {
  assert.equal(currentModelForRole(catalog, "fallback").model, "reasoner");
  assert.equal(currentModelForRole({ ...catalog, current: { fallback: [{ provider: "legacy", model: "old" }] } }, "fallback").model, "old");
  assert.equal(currentModelForRole(catalog, "voice").model, "voice");
  assert.equal(currentModelForRole({ ...catalog, voice: { usesDefault: true } }, "voice"), null);
  assert.equal(isCurrentModel({ provider: "remote", model: "same" }, catalog.current), false);
  const empty = sanitizeModelCatalog({});
  for (const role of ["primary", "fallback", "voice"]) assert.equal(currentModelForRole(empty, role), null);
});

test("source labels preserve the distinction between installed, configured, and provider lists", () => {
  assert.equal(modelSourceLabel("installed"), "Installed Hermes catalog");
  assert.equal(modelSourceLabel("current-config"), "Your configuration");
  assert.equal(modelSourceLabel("live"), "Provider catalog");
  assert.equal(modelSourceLabel("hermes-cache"), "Cached provider catalog");
  assert.equal(modelAvailabilityLabel({}), "Available to choose");
  assert.equal(modelAvailabilityLabel({ availability: "deprecated" }), "Hosted endpoint deprecated");
});

test("server assignments accept Hermes-native providers for Talk and Chat and preserve fallback shape", () => {
  const sanitized = sanitizeModelCatalog(catalog, { usesDefault: true });
  assert.equal(currentModelForRole(sanitized, "fallback").model, "reasoner");
  assert.equal(sanitized.providers[1].canUseForVoice, true);
  assert.equal(validateModelSelection(sanitized, { role: "voice", provider: "remote", model: "reasoner" }).id, "remote");
  assert.equal(validateModelSelection(sanitized, { role: "voice", provider: "", model: "" }), null);
  assert.equal(validateModelSelection(sanitized, { role: "primary", provider: "remote", model: "reasoner" }).id, "remote");
});

test("catalog sanitization keeps a bounded local compatibility warning", () => {
  const sanitized = sanitizeModelCatalog({ ...catalog, degraded: true, registryStatus: "unavailable", warning: "Hermes registry is unavailable." });
  assert.equal(sanitized.degraded, true);
  assert.equal(sanitized.registryStatus, "unavailable");
  assert.equal(sanitized.warning, "Hermes registry is unavailable.");
});

test("known unavailable selections cannot bypass server validation as custom model IDs", () => {
  const unavailable = { ...catalog, providers: [{ id: "nvidia", configured: true, supportsCustomModel: true, models: [{ id: "retired", available: false, availabilityNote: "Hosted endpoint deprecated." }] }] };
  assert.throws(() => validateModelSelection(unavailable, { role: "voice", provider: "nvidia", model: "retired" }), /deprecated/);
});

test("saved roles and explicit test results have separate truthful access states", () => {
  const models = catalogModels({ ...catalog, providers: catalog.providers.map(provider => ({
    ...provider, supportsProbe: true, models: provider.models.map(model => model.id === "voice" ? { ...model, probe: { ok: false, detail: "Provider is rate limited." } } : model),
  })) });
  assert.equal(models.find(model => model.provider === "local" && model.model === "same").accessLabel, "Configured");
  assert.equal(models.find(model => model.provider === "remote" && model.model === "same").accessLabel, "Available to choose");
  assert.equal(models.find(model => model.model === "voice").accessLabel, "Configured · test failed");
  assert.equal(models.find(model => model.model === "voice").selectable, true);
  assert.equal(models.find(model => model.model === "voice").canTest, true);
  assert.equal(models.find(model => model.provider === "unconfigured").accessLabel, "Provider needs setup");
  assert.equal(models.find(model => model.provider === "unconfigured").canTest, false);
});

test("default choices hide obsolete IDs, keep saved assignments, and preserve partial catalog selections", () => {
  const partial = { current: { provider: "local", model: "saved" }, providers: [{ id: "local", configured: true, models: [{ id: "retired", available: false }, { id: "new" }] }] };
  const models = catalogModels(partial);
  assert.deepEqual(filterCatalogModels(models).map(model => model.model), ["saved", "new"]);
  assert.equal(filterCatalogModels(models, { provider: "all" }).length, 3);
  assert.equal(models.find(model => model.model === "saved").accessLabel, "Configured");
  assert.equal(partial.providers[0].models.length, 2, "normalizing must not mutate the cached server response");
  const orphan = catalogModels({ current: { provider: "missing-provider", model: "saved" }, providers: [] });
  assert.equal(orphan[0].accessLabel, "Saved · provider needs setup");
  assert.equal(orphan[0].selectable, false);
  assert.equal(filterCatalogModels(orphan).length, 1);
});

test("a valid provider response supports tested status without silently claiming configured access", () => {
  const models = catalogModels({ providers: [{ id: "remote", configured: true, supportsProbe: true, models: [{ id: "tested", probe: { ok: true } }, { id: "native" }] }] });
  assert.equal(models[0].accessLabel, "Test passed");
  assert.equal(models[1].accessLabel, "Available to choose");
  const safe = sanitizeModelCatalog({ providerCredentialRevisions: { remote: "b".repeat(64) }, credentialConfigRevision: "a".repeat(64), credentialEnvVars: ["CUSTOM_PRIVATE_KEY"], providers: [{ id: "remote", configured: true, supportsProbe: true, models: [{ id: "tested", apiKey: "secret", probe: { rawBody: "secret" } }] }] });
  assert.equal(safe.providers[0].supportsProbe, true);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  assert.equal("credentialEnvVars" in safe, false);
  assert.equal("credentialConfigRevision" in safe, false);
  assert.equal("providerCredentialRevisions" in safe, false);
});

test("assignments reject malformed provider IDs and model input types", () => {
  for (const provider of [null, {}, "../local", "local\n"]) assert.throws(() => validateModelSelection(catalog, { provider, model: "same" }), /provider/);
  for (const model of [{}, ["same"], "bad id", "x".repeat(201)]) assert.throws(() => validateModelSelection(catalog, { provider: "local", model }), /model ID/);
});
