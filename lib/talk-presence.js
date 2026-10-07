const VOICE_COPY = Object.freeze({
  starting: ["Starting microphone.", "Connecting to your microphone. Hermes is not listening yet.", "SETTING UP MICROPHONE"],
  listening: ["I'm listening.", "Speak naturally. Hermes will respond when you finish.", "CONVERSATION IN PROGRESS"],
  capturing: ["I'm listening.", "Listening. Take your time.", "CONVERSATION IN PROGRESS"],
  transcribing: ["Getting your message.", "Turning your speech into a message.", "CONVERSATION IN PROGRESS"],
  thinking: ["Working on that.", "Following your request. Progress is available below.", "CONVERSATION IN PROGRESS"],
  speaking: ["Here's what I found.", "Hold Push to talk to interrupt. Your answer is saved in Chat.", "CONVERSATION IN PROGRESS"],
  error: ["Let's try again.", "Your conversation is saved. You can retry below.", "NEEDS ATTENTION"],
});

const ACKNOWLEDGED_ACTIVITY_SOURCES = new Set(["voice/action", "voice/data", "hermes/tool", "hermes/task"]);
const VOICE_ORB_STATE = Object.freeze({
  starting: "connecting",
  listening: "listening",
  capturing: "listening",
  transcribing: "solving",
  thinking: "solving",
  speaking: "composing",
  error: "breathing",
});
const ACTIVE_VOICE_STATES = new Set(["listening", "capturing", "transcribing", "thinking", "speaking"]);

function presence(state, label, description, eyebrow, active, orbState = "breathing", source = "talk") {
  return {
    state, label, description, eyebrow, active,
    // This is the only activity projection the Talk avatar consumes. Keeping
    // it beside the copy prevents the visual from implying work the caption
    // has rejected as uncorrelated or stale.
    avatarActivity: { state, label, source, orbState, isStale: false },
  };
}

export function deriveTalkPresence({ voiceState = "idle", permission, runtimeStatus, agentRuntimeStatus, agentRuntimeError, connected = false, connectionError = false } = {}) {
  const voice = VOICE_COPY[voiceState];
  if (voice) return presence(voiceState, voice[0], voice[1], voice[2], ACTIVE_VOICE_STATES.has(voiceState), VOICE_ORB_STATE[voiceState], "voice");
  if (permission === "pending") return presence("starting", "Waiting for microphone permission.", "Hermes is not listening until microphone access is ready.", "SETTING UP MICROPHONE", false, "connecting", "voice");

  const acknowledgedWork = runtimeStatus?.state === "working" && !runtimeStatus?.isStale &&
    ACKNOWLEDGED_ACTIVITY_SOURCES.has(runtimeStatus?.source) && Boolean(runtimeStatus?.updatedAt);
  if (acknowledgedWork) return presence(
    "working",
    runtimeStatus.label || "Working on your request.",
    "Following the acknowledged request. Progress is available below.",
    "WORKING",
    true,
    runtimeStatus.orbState || "working",
    runtimeStatus.source,
  );
  if (agentRuntimeStatus === "warming") return presence("starting", "Getting ready.", "Opening this conversation so your next reply can start quickly.", "CONNECTING HERMES", false, "connecting");
  if (agentRuntimeStatus === "error") return presence("offline", "Hermes needs attention.", agentRuntimeError || "The conversation could not connect. Try again, or check your model settings.", "CONNECTION FAILED", false);
  if (connectionError) return presence("offline", "Ready when you are.", "Live status is reconnecting. Your conversation is saved.", "STATUS RECONNECTING", false);
  return presence("idle", "Ready when you are.", "Start a conversation, or hold Push to talk.", connected ? "HERMES IS READY" : "YOUR PERSONAL ASSISTANT", false);
}
