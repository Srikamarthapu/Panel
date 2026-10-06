// A client-generated action ID exists before POST acceptance. Only a matching
// server-confirmed ID proves that switching can detach a durable server run.
export function sessionSwitchBlocked(voice) {
  const accepted = !!voice?.requestPending && !!voice?.actionId && voice?.acceptedActionId === voice.actionId;
  return !!voice?.continuousRequested || !!voice?.pttRequested || voice?.permission === "pending"
    || !!voice?.permissionSaving
    || ["starting", "transcribing", "speaking", "capturing", "listening"].includes(voice?.state)
    || !!voice?.requestPending && !accepted
    || voice?.state === "thinking" && !accepted;
}
