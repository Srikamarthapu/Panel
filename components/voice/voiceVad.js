const VAD_ASSET_PATH = "/voice-vad/";
const ORT_ASSET_PATH = `${VAD_ASSET_PATH}onnx/`;
let vadModulePromise;

// Start the local JS download alongside microphone permission. This does not
// request a microphone, initialize inference, or contact a speech provider.
export function preloadContinuousSpeechDetector() {
  if (!vadModulePromise) {
    vadModulePromise = import("@ricky0123/vad-web").catch((error) => {
      vadModulePromise = null;
      throw error;
    });
  }
  return vadModulePromise;
}

export function pcm16kToWavBlob(samples) {
  const audio = samples instanceof Float32Array ? samples : new Float32Array(samples || []);
  const buffer = new ArrayBuffer(44 + audio.length * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + audio.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, audio.length * 2, true);
  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function hasAudibleInputFrame(frame) {
  if (!(frame instanceof Float32Array) || frame.length === 0) return false;
  for (let index = 0; index < frame.length; index += 16) {
    if (Number.isFinite(frame[index]) && Math.abs(frame[index]) >= 0.00001) return true;
  }
  return false;
}

export function vadFrameStatus(probabilities, frame) {
  return {
    inferred: Number.isFinite(probabilities?.isSpeech) && Number.isFinite(probabilities?.notSpeech),
    hasSignal: hasAudibleInputFrame(frame),
  };
}

export async function createContinuousSpeechDetector({
  audioContext,
  stream,
  onFrameProcessed,
  onSpeechRealStart,
  onSpeechEnd,
  onVADMisfire,
  vadModule,
}) {
  const module = vadModule || await preloadContinuousSpeechDetector();
  const detector = await module.MicVAD.new({
    model: "v5",
    startOnLoad: false,
    audioContext,
    getStream: async () => stream,
    // VoiceProvider owns the stream and AudioContext. Pausing inference must
    // never stop tracks or close the gesture-unlocked context.
    pauseStream: async () => {},
    resumeStream: async () => stream,
    processorType: "auto",
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: ORT_ASSET_PATH,
    ortConfig: (ort) => {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    },
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    preSpeechPadMs: 640,
    redemptionMs: 800,
    minSpeechMs: 256,
    submitUserSpeechOnPause: false,
    onFrameProcessed,
    onSpeechRealStart,
    onSpeechEnd,
    onVADMisfire,
  });
  await detector.start();
  return detector;
}
