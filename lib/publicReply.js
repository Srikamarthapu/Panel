import { MAX_USER_TEXT, MAX_ASSISTANT_TEXT, MAX_TRANSCRIPT_ENTRIES } from "./conversation-limits.js";

const INTERNAL_TYPES = new Set([
  "tool", "tool_call", "tool_use", "tool_result", "function_call", "function_call_output",
  "reasoning", "analysis", "thinking", "usage", "metadata",
]);

function isEnvelope(value) {
  return value && typeof value === "object" && !Array.isArray(value) && (
    typeof value.role === "string" || INTERNAL_TYPES.has(value.type) ||
    Array.isArray(value.tool_calls) || value.function_call || value.usage ||
    Array.isArray(value.choices) || Array.isArray(value.messages) || Array.isArray(value.output)
  );
}

/** Select public assistant content using protocol fields before inspecting
 * strings. Tool-bearing assistant turns are progress, not final answers. */
export function assistantFinalText(value) {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index]?.role === "user") break;
      const text = assistantFinalText(value[index]);
      if (text.trim()) return text;
    }
    return "";
  }
  if (Array.isArray(value.messages)) return assistantFinalText(value.messages);
  if (Array.isArray(value.output)) return assistantFinalText(value.output);
  if (Array.isArray(value.choices)) return assistantFinalText(value.choices[0]?.message);
  if (INTERNAL_TYPES.has(value.type) || ["analysis", "reasoning", "commentary"].includes(value.channel)) return "";
  if (value.role && !["assistant", "hermes"].includes(value.role)) return "";
  if ((Array.isArray(value.tool_calls) && value.tool_calls.length) || value.function_call) return "";
  if (typeof value.final_response === "string") return publicReplyText(value.final_response);
  const content = value.content ?? value.text;
  if (typeof content === "string") return publicReplyText(content);
  if (Array.isArray(content)) {
    return content.filter((part) => part && ["text", "output_text"].includes(part.type))
      .map((part) => publicReplyText(typeof part.text === "string" ? part.text : part.text?.value || "")).join("");
  }
  return "";
}

function stripProtocol(text, partial) {
  // DeepSeek DSML uses both full-width and spaced ASCII delimiters in the
  // wild. Normalize only protocol tags, then remove complete or partial blocks.
  text = text.replace(/<\s*(\/?)\s*[|｜\s]*DSML[|｜\s]*(function_calls|tool_calls|calls|invoke|parameter)\b([^>]*)>/gi, "<$1dsml_$2$3>");
  // A serialized role header is withheld until its channel is known.
  let result = (partial ? text.replace(/<\|(?:im_start|start)\|>(?:(?!<\|(?:message|im_sep)\|>|\n)[\s\S])*$/, "") : text)
    .replace(/<(dsml_(?:function_calls|tool_calls|calls|invoke|parameter))\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<\/dsml_[^>]+>/gi, "")
    .replace(/<(think|thinking|analysis|reasoning|tool_call|tool_calls|tool_result|tool_response|function_call|function_calls|invoke|usage)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<function=[^>]*>[\s\S]*?(?:<\/function\s*>|$)/gi, "")
    .replace(/<\|(?:im_start|start)\|>(?:tool|function)\b[\s\S]*?(?:<\|(?:im_end|end)\|>|$)/g, "")
    .replace(/<\|(?:im_start|start)\|>assistant[^\n]*\bto=[^\n]*[\s\S]*?(?:<\|(?:im_end|end)\|>|$)/g, "")
    .replace(/<\|(?:im_start|start)\|>assistant[^\n]*<\|(?:channel|meta_sep)\|>(?:analysis|commentary)[\s\S]*?(?:<\|(?:im_end|end)\|>|$)/g, "")
    .replace(/<\|(?:channel|meta_sep)\|>(?:analysis|commentary)[\s\S]*?(?=<\|(?:channel|meta_sep)\|>final|<\|(?:im_end|end)\|>|$)/g, "")
    .replace(/<｜tool▁calls▁begin｜>[\s\S]*?(?:<｜tool▁calls▁end｜>|$)/g, "")
    .replace(/\[TOOL_CALLS\][\s\S]*?(?:\[\/TOOL_CALLS\]|$)/g, "")
    .replace(/<\|(?:im_start|start)\|>assistant(?:<\|(?:channel|meta_sep)\|>final)?(?:<\|(?:message|im_sep)\|>|\n)?/g, "")
    .replace(/<\|(?:channel|meta_sep)\|>final\s*/g, "")
    .replace(/<\|(?:im_end|end|eot_id|endoftext|finetune_right_pad)\|>|<｜(?:begin▁of▁sentence|end▁of▁sentence)｜>/g, "")
    .replace(/^\s*\[(?:usage|tokens?|debug|tool(?: call| result)?)\][^\n]*(?:\n|$)/gim, "")
    .replace(/^\s*(?:Token usage|Usage|Tokens):\s*(?:\{|\d|(?:input|output|prompt|completion|total)[ _-]tokens?\b)[^\n]*(?:\n|$)/gim, "");

  if (partial) {
    // Withhold a protocol opener split across provider tokens, so no part of
    // '<tool_call>' or a usage header reaches TTS before it is recognized.
    result = result.replace(/<[^>]*$/, "").replace(/\[(?:T(?:O(?:O(?:L(?:_(?:C(?:A(?:L(?:L(?:S)?)?)?)?)?)?)?)?)?)?$/, "");
    const newline = result.lastIndexOf("\n") + 1;
    const tail = result.slice(newline).trimStart();
    if (["Usage:", "Token usage:", "Tokens:", "[usage]", "[debug]", "[tool call]", "[tool result]"].some((prefix) =>
      prefix.toLowerCase().startsWith(tail.toLowerCase()) || tail.toLowerCase().startsWith(prefix.toLowerCase()))) {
      result = result.slice(0, newline);
    }
  }
  return result;
}

/** Remove internal protocol from assistant reply text. Ordinary Markdown,
 * HTML and fenced code stay intact. Never apply this to the user's messages. */
export function publicReplyText(value, { partial = false } = {}) {
  if (value && typeof value === "object") return assistantFinalText(value);
  if (typeof value !== "string") return "";
  const input = value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const trimmed = input.trim();
  if (/^[\[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isEnvelope(parsed) || Array.isArray(parsed) && parsed.some(isEnvelope)) return assistantFinalText(parsed);
    } catch {
      // JSONL CLI/session output has explicit roles. Prefer only its final
      // assistant record; raw tool rows and usage rows cannot become speech.
      const lines = trimmed.split(/\r?\n/);
      const records = lines.flatMap((line) => { try { const item = JSON.parse(line); return isEnvelope(item) ? [item] : []; } catch { return []; } });
      if (records.length) return assistantFinalText(records);
      if (partial || /^\s*\{\s*"(?:tool_calls|function_call|usage|role)"\s*:/.test(trimmed)) return "";
    }
  }

  // Code is an explicit authoring surface: a tutorial containing <tool_call>
  // or a JSON schema must not lose the code the user asked to see.
  let output = "";
  let offset = 0;
  const fences = /(^|\n)([ \t]*)(```+|~~~+)[^\n]*\n/g;
  let match;
  while ((match = fences.exec(input)) !== null) {
    const start = match.index + match[1].length;
    output += stripProtocol(input.slice(offset, start), partial);
    const marker = match[3];
    const closePattern = new RegExp(`(?:^|\\n)[ \\t]*${marker[0]}{${marker.length},}[^\\n]*(?:\\n|$)`, "g");
    closePattern.lastIndex = fences.lastIndex;
    const close = closePattern.exec(input);
    if (!close) return output + (partial ? "" : input.slice(start));
    const end = close.index + close[0].length;
    output += input.slice(start, end);
    offset = end;
    fences.lastIndex = end;
  }
  return output + stripProtocol(input.slice(offset), partial);
}

/** Stream only the stable public prefix. Internal blocks are withheld even
 * when their delimiters arrive one character at a time. */
export async function* publicReplyTokens(tokens) {
  let raw = "";
  let emitted = "";
  for await (const token of tokens) {
    if (typeof token !== "string") continue;
    raw += token;
    if (raw.length > MAX_ASSISTANT_TEXT + 32000) throw new Error("Model reply exceeded the response limit.");
    const next = publicReplyText(raw, { partial: true });
    if (next.startsWith(emitted) && next.length > emitted.length) {
      yield next.slice(emitted.length);
      emitted = next;
    }
  }
  const final = publicReplyText(raw);
  if (final.startsWith(emitted) && final.length > emitted.length) yield final.slice(emitted.length);
}

export function normalizeTranscriptEntries(entries, maxEntries = MAX_TRANSCRIPT_ENTRIES) {
  const unique = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || !["user", "hermes", "assistant"].includes(entry.role)) continue;
    if (entry.kind === "status" || entry.pending === true) continue;
    let role = entry.role === "assistant" ? "hermes" : entry.role;
    let isError = Boolean(entry.isError);
    let text = (role === "user" ? String(entry.text || "") : publicReplyText(entry.text));
    // Older builds persisted transport envelopes as if they were user speech.
    // Collapse only the known STT envelope so normal JSON/code messages remain
    // untouched while the upgraded Chat view cleans up that history.
    if (role === "user") {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && ["STT request failed", "Deepgram request failed", "Speech recognition unavailable"].includes(parsed.error)) {
          text = "Speech recognition could not connect. Try again.";
          role = "hermes";
          isError = true;
        }
      } catch {
        /* ordinary user text */
      }
    }
    text = text.slice(0, role === "user" ? MAX_USER_TEXT : MAX_ASSISTANT_TEXT);
    if (!text.trim()) continue;
    const id = String(entry.id || `${role}-${unique.size}`);
    unique.set(id, { id, role, text, time: typeof entry.time === "string" ? entry.time : "", ...(isError ? { isError: true } : {}) });
  }
  return [...unique.values()].slice(-maxEntries);
}
