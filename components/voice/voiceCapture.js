export const MICROPHONE_REQUEST_TIMEOUT_MS = 15000;

export class VoiceCaptureTimeoutError extends Error {
  constructor(message = "Microphone permission timed out") {
    super(message);
    this.name = "VoiceCaptureTimeoutError";
  }
}

export function withCaptureTimeout(promise, timeoutMs = MICROPHONE_REQUEST_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new VoiceCaptureTimeoutError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function isLiveAudioStream(stream) {
  if (!stream || typeof stream.getAudioTracks !== "function") return false;
  try {
    return stream.getAudioTracks().some((track) =>
      track && track.readyState !== "ended" && track.enabled !== false,
    );
  } catch {
    return false;
  }
}

export function preferredRecorderMimeType(MediaRecorderClass) {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  if (!MediaRecorderClass) return "";
  return candidates.find((candidate) => {
    try {
      return MediaRecorderClass.isTypeSupported(candidate);
    } catch {
      return false;
    }
  }) || "";
}

export function recorderFileName(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type.includes("mp4")) return "recording.m4a";
  if (type.includes("ogg")) return "recording.ogg";
  if (type.includes("wav")) return "recording.wav";
  return "recording.webm";
}

export function createVoiceRecorder(stream, MediaRecorderClass, onChunk) {
  if (!MediaRecorderClass) throw new Error("MediaRecorder is unavailable");
  if (!isLiveAudioStream(stream)) throw new Error("A live audio stream is required");
  const mimeType = preferredRecorderMimeType(MediaRecorderClass);
  const recorder = mimeType
    ? new MediaRecorderClass(stream, { mimeType })
    : new MediaRecorderClass(stream);
  recorder.ondataavailable = (event) => {
    if (event.data?.size > 0) onChunk?.(event.data);
  };
  return recorder;
}

export function deriveVadThresholds(noiseFloor) {
  const floor = Number.isFinite(noiseFloor) ? Math.max(0, noiseFloor) : 0;
  return {
    silence: Math.max(0.002, floor * 1.35),
    speech: Math.max(0.008, floor * 2.2),
    noisy: floor >= 0.04,
  };
}
