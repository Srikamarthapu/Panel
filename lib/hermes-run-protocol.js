import { publicReplyText } from "./publicReply.js";
import { MAX_ASSISTANT_TEXT } from "./conversation-limits.js";

export function friendlyRunError(value) {
  const message = String(value || "");
  if (/auth|credential|401|403|token.*expir|invalid.*key/i.test(message)) return "Hermes could not authenticate with a connected service. Reconnect it in Hermes setup, then try again.";
  if (/model.*(?:not found|unavailable|deprecated|invalid)|404/i.test(message)) return "The selected model is unavailable. Choose another configured model in Models.";
  if (/429|rate.limit|quota|credit/i.test(message)) return "The provider has reached a usage limit. Try another configured model or wait for its limit to reset.";
  if (/timeout|timed out|fetch failed|connection|ENOTFOUND|network/i.test(message)) return "Hermes could not reach the provider. Check your connection, then try again.";
  if (/approv|permission|denied|not.allowed/i.test(message)) return "Hermes needs permission for this action. Review the action and its permissions in Hermes before retrying.";
  return "Hermes could not complete this request. Review the activity and model connection before retrying; an earlier action may already have completed.";
}

/** Only the terminal result is a reply. Text deltas may precede tool use. */
export function readHermesResult(event) {
  if (event?.type !== "result") return null;
  if (Number(event.exit_code) !== 0 || event.error) return { state: "error", response: "", error: friendlyRunError(event.error) };
  const raw = typeof event.text === "string" ? event.text : "";
  const response = publicReplyText(raw).trim();
  // Protocol outside code fences means a requested tool was never executed.
  const prose = raw.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  if (/<\s*[|｜\s]*DSML[|｜\s]*|<tool_call\b|<｜tool▁calls▁begin｜>/i.test(prose)) {
    return { state: "error", response: "", error: "This model returned tool instructions instead of executing them. Choose a model with working tool support in Models, then retry." };
  }
  if (!response) return { state: "error", response: "", error: "The model returned no usable answer. If it attempted an action, check its status before retrying or choose another model." };
  if (response.length > MAX_ASSISTANT_TEXT) return { state: "error", response: "", error: "The answer exceeded the conversation limit. Ask Hermes to split it into smaller parts." };
  return { state: "complete", response, error: "" };
}

/** Normalize the opt-in pre-linger receipt onto the terminal result contract. */
export function readHermesTurnResult(event) {
  if (event?.type !== "turn_result") return null;
  return readHermesResult({ ...event, type: "result" });
}
