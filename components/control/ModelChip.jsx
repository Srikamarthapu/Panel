"use client";

import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import ModelPicker from "./ModelPicker.jsx";
import { useModelResolution } from "./ModelResolutionProvider.jsx";

export default function ModelChip({ surface, compact = false, className = "" }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const models = useModelResolution();
  const resolution = models[surface];
  const modelName = resolution?.friendlyName || resolution?.label || resolution?.requestedModel || (models.loading ? "Resolving model…" : "Model unavailable");
  const origin = resolution?.originLabel || (resolution?.followsMain ? "Main model" : "Route unavailable");
  const raw = [resolution?.requestedProvider, resolution?.requestedModel].filter(Boolean).join(" / ");
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
  return <>
    <button ref={trigger} type="button" className={`modelChip${compact ? " modelChip--compact" : ""}${className ? ` ${className}` : ""}`} title={raw || modelName} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span className="modelChip__provider" aria-hidden="true">{(resolution?.requestedProvider || "M").slice(0, 1).toLocaleUpperCase()}</span><span><strong>{modelName}</strong><small>{origin}</small></span><ChevronDown size={13} aria-hidden="true" />
    </button>
    {open && <ModelPicker surface={surface} onClose={close} />}
  </>;
}
