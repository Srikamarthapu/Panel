// Ordinary status reads are local. Only an explicit diagnostic may contact a
// provider; being configured is deliberately distinct from a successful probe.
export async function getVoiceHealth({ config, apiKey = "", probe = false, fetchImpl = fetch }) {
  const ttsConfigured = config.ttsBackend !== "elevenlabs" || Boolean(config.elevenlabsApiKeys?.length);
  const tts = { ok: ttsConfigured, configured: ttsConfigured, verified: false, backend: config.ttsBackend, ...(!ttsConfigured ? { error: "No API keys configured" } : {}) };
  let stt = { ok: Boolean(apiKey), configured: Boolean(apiKey), verified: false, backend: "deepgram", ...(!apiKey ? { error: "DEEPGRAM_API_KEY not set" } : {}) };
  if (probe && apiKey) {
    try {
      const silent = Buffer.alloc(76);
      silent.write("RIFF", 0); silent.writeUInt32LE(68, 4); silent.write("WAVEfmt ", 8);
      silent.writeUInt32LE(16, 16); silent.writeUInt16LE(1, 20); silent.writeUInt16LE(1, 22);
      silent.writeUInt32LE(16_000, 24); silent.writeUInt32LE(32_000, 28);
      silent.writeUInt16LE(2, 32); silent.writeUInt16LE(16, 34);
      silent.write("data", 36); silent.writeUInt32LE(32, 40);
      const response = await fetchImpl("https://api.deepgram.com/v1/listen?model=nova-3", {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/wav" },
        body: silent,
        signal: AbortSignal.timeout(5_000),
      });
      stt = { ...stt, ok: response.ok, verified: response.ok, status: response.status, checkedAt: new Date().toISOString() };
      await response.body?.cancel();
    } catch {
      stt = { ...stt, ok: false, error: "Speech recognition connection check failed", checkedAt: new Date().toISOString() };
    }
  }
  return { status: tts.ok && stt.ok ? "running" : "error", readiness: tts.configured && stt.configured ? "configured" : "missing-configuration", tts, stt };
}
