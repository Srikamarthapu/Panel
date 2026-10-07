/** Resolve the two conversation routes that own response modality. */
export function conversationModeForPathname(pathname) {
  if (typeof pathname !== "string" || !pathname) return "default";
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/chat" || path.startsWith("/chat/")) return "chat";
  if (path === "/" || path === "/talk" || path.startsWith("/talk/")) return "talk";
  return "default";
}

/** Text input stays text-only; Chat also makes recognized speech text-only. */
export function resolveTextOnlyMode(requestedTextOnly, conversationMode) {
  return requestedTextOnly === true || conversationMode === "chat";
}

/** Chat suppresses output audio while retaining the original run modality. */
export function shouldSuppressVoiceOutput(conversationMode, textOnly = false) {
  return textOnly === true || conversationMode === "chat";
}

/** A late getUserMedia result must not revive capture after a route change. */
export function canAcceptVoiceCapture({
  startedGeneration,
  currentGeneration,
  conversationMode,
  signal,
}) {
  return startedGeneration === currentGeneration && conversationMode !== "chat" && !signal?.aborted;
}
