/** Build the actual request used by VoiceProvider. Both the body and Accept
 * header select transport: the server also treats audio Accept as opt-in. */
export function voiceChatRequest({ text, sessionId, sttMs = 0, textOnly = false, history, signal, actionId }) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: textOnly ? "application/json" : "audio/mpeg, application/json",
    },
    body: JSON.stringify({ text, sessionId, audio: !textOnly, stt_ms: sttMs, ...(history?.length ? { history } : {}), ...(actionId ? { actionId } : {}) }),
    ...(signal ? { signal } : {}),
  };
}

export function completionRunId(event) {
  return String(event?.id || "").replace(/:(complete|failed)$/, "");
}

export function isTextCompletion(event, textRunIds) {
  return event?.textOnly === true || Boolean(textRunIds?.has(completionRunId(event)));
}
