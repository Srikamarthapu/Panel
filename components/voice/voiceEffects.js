import { reducer } from "./voiceMachine.js";

// React can batch a pipeline transition with an unrelated settings update.
// Retain every command until the imperative runner explicitly accepts it.
export function queuedVoiceReducer(previous, event) {
  if (event.type === "ACK_EFFECTS") {
    return { ...previous, effects: previous.effects.filter((effect) => effect.effectId > event.through) };
  }
  const next = reducer(previous, event);
  let sequence = previous.effectSequence || 0;
  const cancelled = ["CANCEL_CURRENT", "CANCEL_PTT", "STREAM_RESET", "BARGE_IN_DETECTED"].includes(event.type) || (event.type === "STOP_PTT" && previous.state.pttRequested) || (event.type === "TOGGLE_CONTINUOUS" && (previous.state.continuousRequested || !["idle", "error"].includes(previous.state.state)));
  // Chat route changes suppress pending speech effects but retain queued work.
  const suppressSpeech = event.type === "RESPONSE_MODE_CHANGED" && event.mode === "chat";
  const queuedEffects = cancelled ? [] : previous.effects || [];
  const retainedEffects = suppressSpeech ? queuedEffects.filter((effect) => !["callTTS", "playAudio"].includes(effect.kind)) : queuedEffects;
  const revokeEffects = suppressSpeech
    ? queuedEffects.filter((effect) => effect.kind === "playAudio" && effect.url).map((effect) => ({ kind: "revokeURL", url: effect.url }))
    : [];
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
