import { getVoiceConfig, saveVoiceConfig } from "@/lib/voice";
import { handleVoiceChatRequest } from "@/lib/voice-chat-handler.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const publicFields = ["ttsBackend", "ttsVoice", "ttsRate", "ttsPitch", "ttsVolume", "elevenlabsVoiceId", "elevenlabsModel", "sttBackend", "sttLanguage", "voiceModelProvider", "voiceModel", "voiceReasoningEffort", "micDeviceId", "speakerDeviceId", "muteOutput", "autoSpeak", "enabled"];
function publicConfig(config) { return Object.fromEntries(publicFields.map(key => [key, config[key]])); }
/** Every turn uses Hermes's actual tools and resumes the same conversation.
 * Acknowledgements are status only; the terminal result arrives via /runs. */
export async function POST(request) { return handleVoiceChatRequest(request); }
export function GET() { return Response.json({ config: publicConfig(getVoiceConfig()) }); }
export async function PUT(request) {
  try {
    const body = await request.json();
    const patch = Object.fromEntries(publicFields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    return Response.json({ config: publicConfig(saveVoiceConfig(patch)) });
  } catch { return Response.json({ error: "Voice settings could not be saved." }, { status: 400 }); }
}
