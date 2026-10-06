import { spawn } from "node:child_process";
import { getVoiceConfig, sanitizeForVoice } from "@/lib/voice";
import { synthesizeStreamWithFailover } from "@/lib/elevenlabs";
import { publicReplyText } from "@/lib/publicReply";
import { spokenExcerpt, MAX_SPOKEN_TEXT } from "@/lib/conversation-limits";
import os from "node:os";
import path from "node:path";

/**
 * POST /api/voice/tts
 * Body: { text: string, voice?: string, rate?: string, pitch?: string, volume?: string }
 *
 * Two backends:
 *   - "elevenlabs" (default when keys are configured) — high-quality neural
 *      TTS. We hit the streaming endpoint with optimize_streaming_latency=2
 *      so first audio bytes arrive in ~200-400ms and we forward chunks to
 *      the browser as they land. Same model, same voice settings, same
 *      mp3_44100_128 quality as before — only transport changed. On total
 *      key exhaustion or pre-stream failure we fall through to edge-tts.
 *   - "edge-tts" — Microsoft Edge neural voices via the local Python CLI.
 */
export async function POST(request) {
  const config = getVoiceConfig();

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "A JSON object is required" }, { status: 400 });

  // Strip any bracketed prosody / stage-direction markers so they aren't spoken.
  const text = sanitizeForVoice(spokenExcerpt(publicReplyText(body.text)), { maxChars: MAX_SPOKEN_TEXT });

  if (!text) {
    return Response.json({ error: "No speakable text provided" }, { status: 400 });
  }

  const backend = body.backend || config.ttsBackend || "elevenlabs";
  const elevenlabsConfigured =
    Array.isArray(config.elevenlabsApiKeys)
      ? config.elevenlabsApiKeys.filter(Boolean).length > 0
      : Boolean(config.elevenlabsApiKey);

  if (backend === "elevenlabs" && elevenlabsConfigured) {
    try {
      const { stream } = await synthesizeStreamWithFailover({
        text,
        voiceId: body.voiceId || config.elevenlabsVoiceId,
        modelId: body.modelId || config.elevenlabsModel,
        voiceSettings: body.voiceSettings || config.elevenlabsVoiceSettings,
        config,
        signal: request.signal,
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-TTS-Backend": "elevenlabs-stream",
          // No Content-Length: chunked transfer.
        },
      });
    } catch (err) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      // 4xx that isn't a key problem (bad voice id, malformed body, etc.) —
      // surface immediately, don't silently fall back to a different voice.
      if (err && err.kind === "bad_request") {
        return Response.json(
          {
            error: "ElevenLabs rejected the request",
            details: "Check the selected voice and model in Voice settings.",
          },
          { status: err.status || 400 }
        );
      }
      // Otherwise: keys exhausted or network problem → fall through to
      // edge-tts so voice still works.
      // eslint-disable-next-line no-console
      console.warn(
        "[tts] ElevenLabs failed, falling back to edge-tts:",
        err?.kind || err?.message || err
      );
    }
  }

  return synthesizeWithEdge({ body, config, text, signal: request.signal });
}

/** Spawn `edge-tts` and pipe its MP3 stdout back to the client. */
function synthesizeWithEdge({ body, config, text, signal }) {
  const voice = body.voice || config.ttsVoice || "en-US-AriaNeural";
  const rate = body.rate ?? config.ttsRate ?? "+0%";
  const pitch = body.pitch ?? config.ttsPitch ?? "+0Hz";
  const volume = body.volume ?? config.ttsVolume ?? "+0%";

  return new Promise((resolve) => {
    const args = [
      "--text", text,
      "--voice", voice,
      "--rate", rate,
      "--pitch", pitch,
      "--volume", volume,
      "--write-media", "/dev/stdout",
    ];

    const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
    const repo = process.env.HERMES_REPO || path.join(hermesHome, "hermes-agent");
    const child = spawn("edge-tts", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${os.homedir()}/.local/bin:${repo}/venv/bin:${process.env.PATH || ""}` } });

    const chunks = [];
    let stderr = "";
    let resolved = false;
    const finish = (response) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(response);
    };
    const abort = () => { try { child.kill("SIGKILL"); } catch {} finish(new Response(null, { status: 499 })); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(Response.json({ error: "Speech generation timed out. Your reply is still in Chat." }, { status: 504 }));
    }, 25000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (resolved) return;
      finish(
        Response.json(
          { error: "edge-tts failed to start", details: err.message },
          { status: 500 }
        )
      );
    });

    child.on("close", (code) => {
      if (resolved) return;

      if (code !== 0 || chunks.length === 0) {
        return finish(
          Response.json(
            {
              error: `edge-tts exited with code ${code}`,
              details: "Speech generation is unavailable. Your reply is still in Chat.",
            },
            { status: 502 }
          )
        );
      }

      const audio = Buffer.concat(chunks);
      finish(
        new Response(audio, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(audio.length),
            "Cache-Control": "no-store",
            "X-TTS-Backend": "edge-tts",
          },
        })
      );
    });

  });
}
