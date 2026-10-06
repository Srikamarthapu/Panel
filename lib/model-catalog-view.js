// Normalize the local/provider catalog for both the full browser and voice picker.
export function catalogModels(catalog) {
  const savedSelections = [
    ["primary", currentModelForRole(catalog, "primary")],
    ["fallback", currentModelForRole(catalog, "fallback")],
    ["voice", currentModelForRole(catalog, "voice")],
  ];
  const providers = [...(catalog?.providers || [])];
  // Saved assignments remain inspectable when an older/partial catalog omits
  // their provider or ID; this does not imply credentials or access exist.
  for (const [, selection] of savedSelections) {
    if (!selection?.provider || !selection.model) continue;
    let provider = providers.find(row => row.id === selection.provider);
    if (!provider) { provider = { id: selection.provider, label: selection.provider, configured: false, models: [] }; providers.push(provider); }
    if (!(provider.models || []).some(entry => (typeof entry === "string" ? entry : entry.id || entry.model) === selection.model)) {
      const replacement = { ...provider, models: [{ id: selection.model, source: "current-config", availability: "not-listed" }, ...(provider.models || [])] };
      providers[providers.indexOf(provider)] = replacement;
    }
  }
  return providers.flatMap((provider) =>
    (provider.models || []).map((entry) => {
      const model = typeof entry === "string" ? { id: entry } : entry;
      const id = String(model.id || model.model || "");
      const savedRoles = savedSelections.filter(([, selection]) => selection?.provider === provider.id && selection.model === id).map(([role]) => role);
      const selectable = Boolean(provider.configured) && !catalog?.degraded && model.available !== false;
      const access = modelAccessState(model, provider, savedRoles, catalog?.degraded);
      return {
        ...model,
        key: JSON.stringify([provider.id, id]),
        model: id,
        label: model.label || id,
        provider: provider.id,
        providerLabel: provider.label || provider.id,
        configured: Boolean(provider.configured),
        canUseForVoice: Boolean(provider.configured),
        savedRoles,
        source: model.source || "installed",
        selectable,
        canTest: selectable && Boolean(provider.supportsProbe),
        probeNote: provider.probeNote || (!provider.configured ? "Connect this provider before testing a model." : ""),
        ...access,
      };
    }).filter((model) => model.model)
  );
}

export function filterCatalogModels(models, { provider = "configured", query = "", role = "primary", showUnavailable = false } = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((model) =>
    (provider === "all" || (provider === "configured" ? model.configured || model.savedRoles?.length : model.provider === provider)) &&
    (provider === "all" || showUnavailable || model.selectable || model.savedRoles?.length) &&
    (role !== "voice" || model.canUseForVoice || model.savedRoles?.includes("voice")) &&
    terms.every((term) => `${model.label} ${model.model} ${model.provider} ${model.providerLabel}`.toLowerCase().includes(term))
  );
}

export function currentModelForRole(catalog, role) {
  if (role === "voice") {
    const voice = catalog?.voice;
    return !voice || voice.usesDefault || !voice.model ? null : voice;
  }
  if (role === "fallback") {
    const fallback = catalog?.current?.fallback;
    const selection = Array.isArray(fallback) ? fallback[0] : fallback;
    return selection?.model ? selection : null;
  }
  return catalog?.current?.model ? catalog.current : null;
}

export function isCurrentModel(model, current) {
  return Boolean(current?.model && model.provider === current.provider && model.model === current.model);
}

export function modelSourceLabel(source = "") {
  if (/cache/i.test(source)) return "Cached provider catalog";
  if (/live|remote|provider|api/i.test(source)) return "Provider catalog";
  if (/config|current|custom/i.test(source)) return "Your configuration";
  return "Installed Hermes catalog";
}

export function canAssignCustomModel(provider, role, modelId) {
  return Boolean(provider?.configured && provider.supportsCustomModel !== false &&
    String(modelId || "").trim());
}

export function modelAvailabilityLabel(model) {
  if (model?.accessLabel) return model.accessLabel;
  if (model?.availability === "deprecated") return "Hosted endpoint deprecated";
  if (model?.available === false) return "Unavailable for selection";
  if (model?.savedRoles?.length) return "Configured";
  if (model?.availability === "not-listed") return "Custom model ID";
  return "Available to choose";
}

export function modelAccessState(model, provider, savedRoles = [], degraded = false) {
  const saved = savedRoles.length > 0;
  if (model.availability === "deprecated" || model.available === false) return {
    accessState: "unavailable", accessLabel: model.availability === "deprecated" ? "Deprecated endpoint" : "Unavailable",
    accessDetail: model.availabilityNote || "This model is unavailable for new assignments.",
  };
  if (degraded) return { accessState: "read-only", accessLabel: saved ? "Saved · setup unavailable" : "Setup unavailable", accessDetail: "Hermes setup could not be checked. Saved assignments are preserved while setup is read-only." };
  if (!provider.configured) return { accessState: "needs-setup", accessLabel: saved ? "Saved · provider needs setup" : "Provider needs setup", accessDetail: "Connect this provider in Hermes before using its models." };
  if (model.probe?.ok === true) return { accessState: "tested", accessLabel: saved ? "Configured · test passed" : "Test passed", accessDetail: "This exact model returned a response to an explicit test. Account access and provider availability can change." };
  if (model.probe?.ok === false) return { accessState: "test-failed", accessLabel: saved ? "Configured · test failed" : "Test failed", accessDetail: model.probe.detail || "The last explicit model test failed. You can retry; the saved assignment is preserved." };
  if (saved) return { accessState: "configured", accessLabel: "Configured", accessDetail: model.availability === "not-listed" ? "Saved as an exact model ID. Catalogs can omit aliases and private IDs; run a test to check current access." : "Saved in your Hermes setup. A saved assignment is separate from an explicit model test." };
  return { accessState: "selectable", accessLabel: "Available to choose", accessDetail: "Your provider is connected and this ID can be selected. A provider listing does not confirm inference access." };
}
