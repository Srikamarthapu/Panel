import { reducer } from "./voiceMachine.js";

// React can batch a pipeline transition with an unrelated settings update.
// Retain every command until the imperative runner explicitly accepts it.
export function queuedVoiceReducer(previous, event) {
  if (event.type === "ACK_EFFECTS") {
    return { ...previous, effects: previous.effects.filter((effect) => effect.effectId > event.through) };
  }
  const next = reducer(previous, event);
  let sequence = previous.effectSequence || 0;
  const cancelled = ["CANCEL_CURRENT", "CANCEL_PTT"].includes(event.type) || (event.type === "STOP_PTT" && previous.state.pttRequested) || (event.type === "TOGGLE_CONTINUOUS" && (previous.state.continuousRequested || !["idle", "error"].includes(previous.state.state)));
  return {
    state: next.state,
    effects: [...(cancelled ? [] : previous.effects || []), ...next.effects.map((effect) => ({ ...effect, effectId: ++sequence }))],
    effectSequence: sequence,
  };
}
