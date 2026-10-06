import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getVoiceConfig } from "@/lib/voice";

const execFileAsync = promisify(execFile);

let cachedVoices = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

/**
 * GET /api/voice/voices
 * Returns the catalogue of Microsoft Edge neural voices via `edge-tts --list-voices`.
 * Result is cached in-memory for 5 minutes since the list rarely changes.
 */
export async function GET() {
  const config = getVoiceConfig();

  try {
    if (!cachedVoices || Date.now() - cachedAt > CACHE_MS) {
      const { stdout } = await execFileAsync("edge-tts", ["--list-voices"], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      cachedVoices = parseVoiceTable(stdout);
      cachedAt = Date.now();
    }
    return Response.json({
      voices: cachedVoices,
      activeVoice: config.ttsVoice || "en-US-AriaNeural",
    });
  } catch (err) {
    return Response.json(
      {
        voices: [],
        activeVoice: config.ttsVoice || "en-US-AriaNeural",
        error: (err.stderr || err.message || "").toString().slice(0, 300),
      },
      { status: 500 }
    );
  }
}

/**
 * Parse the simple two-column table edge-tts prints. Output looks like:
 *
 *   Name                              Gender
 *   --------------------------------  -------
 *   af-ZA-AdriNeural                  Female
 *   af-ZA-WillemNeural                Male
 *   ...
 */
function parseVoiceTable(stdout) {
  const lines = stdout.split(/\r?\n/);
  const voices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Name") || trimmed.startsWith("---")) continue;
    const parts = trimmed.split(/\s{2,}|\t+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [name, gender, ...rest] = parts;
    if (!/Neural$/i.test(name)) continue; // skip the rare non-neural entries
    const locale = name.split("-").slice(0, 2).join("-");
    voices.push({
      name,
      gender,
      locale,
      categories: rest.join(" ") || null,
    });
  }
  return voices;
}
