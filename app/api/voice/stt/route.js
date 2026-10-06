import { getVoiceConfig } from "@/lib/voice";
import { requestSpeechRecognition, speechFailure } from "@/lib/speech-recognition.js";

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
function failure(status, code, message, retryable = false) {
  return Response.json({ error: "Speech recognition unavailable", code, message, retryable }, { status });
}

export async function POST(request) {
  const startedAt = Date.now();
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return failure(400, "STT_NO_AUDIO", "No recording was received. Please try speaking again.");
    if (file.size < 100) return failure(400, "STT_EMPTY_AUDIO", "The recording was too short. Please try speaking again.");
    if (file.size > MAX_AUDIO_BYTES) return failure(413, "STT_AUDIO_TOO_LARGE", "This recording is too large. Try a shorter recording.");
    const apiKey = process.env.DEEPGRAM_API_KEY || "";
    if (!apiKey) return failure(503, "STT_NOT_CONFIGURED", "Speech recognition needs a Deepgram API key in the server configuration. You can still type in Chat.");
    const config = getVoiceConfig();
    const params = new URLSearchParams({ model: "nova-3", smart_format: "true", punctuate: "true", keyterm: "Hermes" });
    if (config.sttLanguage && config.sttLanguage !== "auto") params.set("language", config.sttLanguage);
    else params.set("detect_language", "true");
    const response = await requestSpeechRecognition(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": file.type || "audio/webm" },
      body: Buffer.from(await file.arrayBuffer()),
      signal: request.signal,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* closed */ }
      console.warn(`[stt] provider_status=${response.status} elapsed_ms=${Date.now() - startedAt}`);
      if ([401, 403].includes(response.status)) return failure(502, "STT_AUTH_FAILED", "Speech recognition rejected the configured API key. Update the Deepgram key in the server configuration.");
      if (response.status === 429) return failure(503, "STT_RATE_LIMITED", "Speech recognition is busy or has reached its usage limit. Try this recording again in a moment.", true);
      return failure(502, "STT_PROVIDER_ERROR", "Speech recognition could not process the recording. You can retry this recording.", response.status >= 500);
    }
    const data = await response.json();
    const alternative = data?.results?.channels?.[0]?.alternatives?.[0];
    if (!alternative || typeof alternative.transcript !== "string") return failure(502, "STT_INVALID_RESPONSE", "Speech recognition returned an incomplete result. You can retry this recording.", true);
    console.info(`[stt] ok elapsed_ms=${Date.now() - startedAt} audio_seconds=${data?.metadata?.duration ?? "unknown"} text_chars=${alternative.transcript.length}`);
    return Response.json({ text: alternative.transcript.trim(), language: data?.results?.channels?.[0]?.detected_language || config.sttLanguage || "en", model: "deepgram-nova-3", confidence: alternative.confidence ?? null, durationSeconds: data?.metadata?.duration ?? null });
  } catch (error) {
    if (request.signal.aborted) return failure(499, "STT_CANCELLED", "Recording cancelled.");
    const { diagnostic, ...result } = speechFailure(error);
    console.error(`[stt] code=${result.code} cause=${diagnostic.replace(/[^A-Za-z0-9_]/g, "").slice(0, 80)} elapsed_ms=${Date.now() - startedAt}`);
    return Response.json({ error: "Speech recognition unavailable", ...result }, { status: 503 });
  }
}
