import { MAX_ASSISTANT_TEXT, MAX_USER_TEXT } from "./conversation-limits.js";
import { publicReplyText } from "./publicReply.js";

const text = (value, limit) => typeof value === "string" ? value.replace(/\u0000/g, "").slice(0, limit).trim() : "";

export function directSystemPrompt({ agentName, agentSoul } = {}) {
  const role = text(agentSoul, 20_000) || (text(agentName, 120) ? `You are ${text(agentName, 120)}, an AI teammate in Panel.` : "You are an AI assistant in Panel.");
  return [
    role,
    "You are running in Panel's direct API mode. You have no tools, file access, command execution, web access, delegation, or background actions. Do not claim to have performed actions you cannot perform. Help through conversation and clearly say when a request needs Hermes mode.",
    "Return only the answer intended for the user. Do not include private reasoning or protocol markup.",
  ].join("\n\n");
}

function turnPrompt(textOnly) {
  return textOnly === true
    ? "This is a written Chat turn. Give a complete answer at the depth the request needs. Use Markdown, code, lists, tables, and links when they improve clarity."
    : "This is a spoken Talk turn. The answer will be read aloud. Default to one to three short, natural sentences, lead with the answer, and avoid Markdown, tables, and long lists.";
}

export function directMessages(payload) {
  const history = (Array.isArray(payload?.history) ? payload.history : []).slice(-24).flatMap(entry => {
    if (!entry || !["user", "assistant"].includes(entry.role)) return [];
    const value = entry.role === "user" ? text(entry.content, MAX_USER_TEXT) : publicReplyText(text(entry.content, MAX_ASSISTANT_TEXT));
    return value ? [{ role: entry.role, content: value }] : [];
  });
  const prompt = text(payload?.text, MAX_USER_TEXT);
  if (!prompt) throw new Error("The direct request is empty.");
  return [{ role: "system", content: `${directSystemPrompt(payload)}\n\n${turnPrompt(payload?.textOnly)}` }, ...history, { role: "user", content: prompt }];
}
