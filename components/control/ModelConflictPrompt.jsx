"use client";

export default function ModelConflictPrompt({ conflicts, busy, onFollow, onKeep, className = "modelConflict" }) {
  if (!conflicts?.length) return null;
  return <section className={className} aria-label="Pinned model choices">
    <strong>Keep each surface in sync?</strong>
    {conflicts.map(conflict => <div key={conflict.surface}>
      <p>{conflict.message || `${conflict.name || conflict.surface} is pinned to ${conflict.pinnedFriendlyName || conflict.pinnedModel}. Switch ${conflict.name || conflict.surface} to ${conflict.mainFriendlyName || conflict.mainModel} too?`}</p>
      <div><button type="button" disabled={busy} onClick={() => onFollow(conflict.surface)}>Switch {conflict.name || conflict.surface} too</button><button type="button" className="modelPicker__quiet" disabled={busy} onClick={() => onKeep(conflict.surface)}>Keep pin</button></div>
    </div>)}
  </section>;
}
