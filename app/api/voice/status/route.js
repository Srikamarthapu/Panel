import { getVoiceConfig } from "@/lib/voice";
import { getVoiceHealth } from "@/lib/voice-health.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/voice/status
 * Reports local configuration. ?probe=1 explicitly checks STT connectivity.
 */
export async function GET(request) {
  const config = getVoiceConfig();
  const apiKey = process.env.DEEPGRAM_API_KEY || "";
  const probe = request?.url ? new URL(request.url).searchParams.get("probe") === "1" : false;
  const health = await getVoiceHealth({ config, apiKey, probe });

  return Response.json({
    ...health,
    // T-0010 Law 9: the build id this server process was built with. The client
    // (already polling this endpoint every 15s) compares it to the build id
    // baked into its own bundle and self-reloads at a safe moment on a
    // mismatch (server redeployed). Same NEXT_PUBLIC_BUILD_ID both sides, so a
    // rebuild changes it here and in the bundle at once.
    buildId: process.env.NEXT_PUBLIC_BUILD_ID || "dev",
    config: {
      ttsBackend: config.ttsBackend,
      ttsVoice: config.ttsVoice,
      ttsRate: config.ttsRate,
      ttsPitch: config.ttsPitch,
      ttsVolume: config.ttsVolume,
      elevenlabsVoiceId: config.elevenlabsVoiceId,
      elevenlabsModel: config.elevenlabsModel,
      sttBackend: config.sttBackend,
      sttLanguage: config.sttLanguage,
      voiceModelProvider: config.voiceModelProvider,
      voiceModel: config.voiceModel,
      voiceReasoningEffort: config.voiceReasoningEffort,
      micDeviceId: config.micDeviceId,
      speakerDeviceId: config.speakerDeviceId,
      muteOutput: config.muteOutput,
      autoSpeak: config.autoSpeak,
      enabled: config.enabled,
    },
  });
}
