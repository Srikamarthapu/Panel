import { reducer } from "./voiceMachine.js";

export function isMicrophoneGenerationEffect(effect) {
  if (!effect || typeof effect !== "object") return false;
  if ([
    "requestPermission",
    "startRecorder",
    "syncContinuous",
    "releaseMicForPlayback",
    "stopAllTracks",
    "closeAudioContext",
  ].includes(effect.kind)) return true;
  return effect.kind === "stopRecorder" && effect.discard === true;
}

// React can batch a pipeline transition with an unrelated settings update.
// Retain every command until the imperative runner explicitly accepts it.
export function queuedVoiceReducer(previous, event) {
  if (event.type === "ACK_EFFECTS") {
    return { ...previous, effects: previous.effects.filter((effect) => effect.effectId > event.through) };
  }
  const next = reducer(previous, event);
  let sequence = previous.effectSequence || 0;
  const cancelled = ["CANCEL_CURRENT", "CANCEL_PTT", "STREAM_RESET", "BARGE_IN_DETECTED"].includes(event.type) || (event.type === "STOP_PTT" && previous.state.pttRequested) || (event.type === "TOGGLE_CONTINUOUS" && (previous.state.continuousRequested || !["idle", "error"].includes(previous.state.state)));
  // Leaving the live voice surface suppresses capture and speech commands but
  // retains durable transcript/chat work. On a same-route Talk mode change,
  // the pathname cannot guard these stale microphone effects for us.
  const suppressSpeech = event.type === "RESPONSE_MODE_CHANGED" && event.mode === "chat";
  const suppressedVoiceEffects = new Set(["requestPermission", "startRecorder", "syncContinuous", "callSTT", "releaseMicForPlayback", "callTTS", "playAudio"]);
  const replaceMicrophone = event.type === "MIC_INPUT_CHANGED";
  const previousEffects = previous.effects || [];
  const queuedEffects = cancelled ? [] : previousEffects;
  let retainedEffects = suppressSpeech ? queuedEffects.filter((effect) => !suppressedVoiceEffects.has(effect.kind)) : queuedEffects;
  if (replaceMicrophone) retainedEffects = retainedEffects.filter((effect) => !isMicrophoneGenerationEffect(effect));
  // A TTS_DONE URL can be queued before the passive effect runner has claimed
  // it. General cancellation drops that queue, so explicitly revoke each URL
  // here; stopAudio cannot see it until playAudio has installed currentTtsRef.
  const droppedAudioUrls = (cancelled || suppressSpeech)
    ? [...new Set(previousEffects.filter((effect) => ["playAudio", "revokeURL"].includes(effect.kind) && effect.url).map((effect) => effect.url))]
    : [];
  if (droppedAudioUrls.length) retainedEffects = retainedEffects.filter((effect) => effect.kind !== "revokeURL" || !droppedAudioUrls.includes(effect.url));
  const revokeEffects = droppedAudioUrls.map((url) => ({ kind: "revokeURL", url }));
  return {
    state: next.state,
    effects: [
      ...retainedEffects,
      ...revokeEffects.map((effect) => ({ ...effect, effectId: ++sequence })),
      ...next.effects.map((effect) => ({ ...effect, effectId: ++sequence })),
    ],
    effectSequence: sequence,
  };
}
