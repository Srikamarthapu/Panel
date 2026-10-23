import { publicReplyText } from "../../lib/publicReply.js";
import { MAX_ASSISTANT_TEXT, MAX_SPOKEN_TEXT } from "../../lib/conversation-limits.js";

const FIRST_SPEECH_CHUNK_MIN_CHARS = 40;
const FOLLOWUP_SPEECH_CHUNK_TARGET_CHARS = 240;

export function createAnswerReconnectBackoff() {
  let attempts = 0;
  return {
    next({ meaningful = false } = {}) {
      if (meaningful) attempts = 0;
      const delay = Math.min(5000, 500 * 2 ** attempts);
      attempts += 1;
      return delay;
    },
  };
}

/** Attribute first audible output once to each run, not once to every TTS
 * sentence. Later clips deliberately omit the first-answer latency field. */
export function createAnswerAudioTiming() {
  const startedRuns = new Set();
  return ({ runId, at, ttsStartedAt, speechEndedAt }) => {
    const key = String(runId || `utterance-${speechEndedAt}`);
    const first = !startedRuns.has(key);
    startedRuns.add(key);
    if (startedRuns.size > 200) startedRuns.delete(startedRuns.values().next().value);
    return {
      source: "voice/timing",
      title: first ? "Answer audio started" : "Answer audio continued",
      summary: `${first ? "Answer" : "Sentence"} TTS to observed playback: ${at - ttsStartedAt}ms${first && speechEndedAt ? `; detected speech end to answer audio: ${at - speechEndedAt}ms` : ""}.`,
      target: key,
    };
  };
}

// Only completed phrases leave this buffer. Reconnect replays use durable
// sequence numbers; raw text is retained so split protocol tags stay hidden.
export function createAnswerSpeechBuffer() {
  let seq = 0;
  let messageId = null;
  let raw = "";
  let publicText = "";
  let consumed = 0;
  let spokenChars = 0;
  let received = false;
  let finished = false;
  let limitAnnounced = false;
  const previousMessages = [];

  function sequenceEnd(value, sequence, { anywhere = false } = {}) {
    const normalize = (token) => token.replace(/[*_`]/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    const expected = [...sequence.matchAll(/\S+/g)].map((match) => normalize(match[0])).filter(Boolean);
    if (!expected.length) return 0;
    const actual = [...value.matchAll(/\S+/g)].filter((match) => normalize(match[0]));
    if (expected.length > actual.length) return -1;
    const lastStart = anywhere ? actual.length - expected.length : 0;
    for (let start = 0; start <= lastStart; start += 1) {
      if (expected.some((token, index) => normalize(actual[start + index][0]) !== token)) continue;
      const last = actual[start + expected.length - 1];
      return last.index + last[0].length;
    }
    return -1;
  }

  function drain(flush = false) {
    const chunks = [];
    while (consumed < publicText.length) {
      const tail = publicText.slice(consumed);
      let end = 0;
      const target = flush
        ? FOLLOWUP_SPEECH_CHUNK_TARGET_CHARS
        : spokenChars === 0
          ? FIRST_SPEECH_CHUNK_MIN_CHARS
          : FOLLOWUP_SPEECH_CHUNK_TARGET_CHARS;
      const boundaries = /[.!?]["')\]]*(?=\s|$)|\n{2,}/g;
      for (const boundary of tail.matchAll(boundaries)) {
        const candidate = boundary.index + boundary[0].length;
        const prefix = tail.slice(0, candidate);
        if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/i.test(prefix)) continue;
        if (/\d\.$/.test(prefix) && candidate === tail.length && !flush) continue;
        end = candidate;
        // A complete sentence is not automatically a good speech clip.
        // Short fragments such as "Sure." reset ElevenLabs prosody and make
        // durable streamed answers sound like isolated words. Keep adjacent
        // sentences together until they form a natural utterance. The final
        // drain still speaks short replies promptly once the run completes.
        if (prefix.trim().length >= target) break;
      }
      if (end && tail.slice(0, end).trim().length < target) end = 0;
      if (end > 280) {
        const bounded = tail.lastIndexOf(" ", 280);
        end = bounded > 0 ? bounded : 280;
      }
      if (!end && tail.length > 280) {
        const bounded = tail.lastIndexOf(" ", 280);
        end = bounded > 0 ? bounded : 280;
      }
      if (!end && flush) end = tail.length;
      if (end <= 0) break;
      const text = tail.slice(0, end).trim();
      consumed += end;
      if (!text) continue;
      if (spokenChars + text.length > MAX_SPOKEN_TEXT) {
        if (!limitAnnounced) chunks.push("The full answer is available in Chat.");
        limitAnnounced = true;
        continue;
      }
      if (!limitAnnounced) {
        spokenChars += text.length;
        chunks.push(text);
      }
    }
    return chunks;
  }

  return {
    get sequence() { return seq; },
    get received() { return received; },
    get text() { return publicText; },
    accept(event, { holdSpeech = false } = {}) {
      if (finished || !Number.isSafeInteger(event?.seq) || event.seq <= seq || typeof event.text !== "string") return null;
      seq = event.seq;
      const chunks = [];
      const nextMessage = String(event.messageId || "answer");
      if (messageId !== null && messageId !== nextMessage) {
        publicText = publicReplyText(raw);
        chunks.push(...drain(true));
        previousMessages.push(publicText.slice(0, consumed));
        raw = "";
        publicText = "";
        consumed = 0;
      }
      messageId = nextMessage;
      raw = (raw + event.text).slice(0, MAX_ASSISTANT_TEXT + 32000);
      const next = publicReplyText(raw, { partial: true }).slice(0, MAX_ASSISTANT_TEXT);
      // Never revise a prefix that has already been handed to the speaker.
      if (next.slice(0, consumed) !== publicText.slice(0, consumed)) return null;
      publicText = next;
      received ||= Boolean(publicText.trim());
      if (!holdSpeech) chunks.push(...drain());
      return { text: publicText, chunks };
    },
    finish(finalText) {
      if (finished) return [];
      finished = true;
      const final = publicReplyText(finalText).slice(0, MAX_ASSISTANT_TEXT);
      // The terminal record is authoritative. If the transport missed the
      // tail, speak only that tail; never replay the sentence already heard.
      const currentSpoken = publicText.slice(0, consumed);
      const allSpoken = previousMessages.concat(currentSpoken).join(" ");
      const combinedEnd = previousMessages.length ? sequenceEnd(final, allSpoken) : -1;
      const currentEnd = sequenceEnd(final, currentSpoken);
      // Some runtimes wrap their canonical result (for example, by prepending
      // "Summary:") after streaming has already spoken the body. Match the
      // complete normalized spoken word sequence at real token boundaries so
      // we can continue after it without either replaying it or fuzzy-skipping
      // unrelated new text.
      const embeddedCombinedEnd = previousMessages.length && consumed > 0
        ? sequenceEnd(final, allSpoken, { anywhere: true })
        : -1;
      const embeddedCurrentEnd = consumed > 0
        ? sequenceEnd(final, currentSpoken, { anywhere: true })
        : -1;
      // Some ACP servers omit message IDs and concatenate a tool preface
      // with its result. Match a complete already-spoken suffix defensively.
      const normalized = (text) => text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
      const spoken = normalized(allSpoken);
      const answer = normalized(final);
      const suffixAt = answer ? spoken.length - answer.length : -1;
      const finalAlreadyHeard = suffixAt >= 0 && spoken.slice(suffixAt) === answer && (suffixAt === 0 || /[\s.!?:;]/.test(spoken[suffixAt - 1]));
      if (finalAlreadyHeard) { publicText = final; consumed = final.length; return []; }
      if (combinedEnd > 0 || currentEnd > 0 || embeddedCombinedEnd > 0 || embeddedCurrentEnd > 0) {
        publicText = final;
        consumed = combinedEnd > 0
          ? combinedEnd
          : currentEnd > 0
            ? currentEnd
            : embeddedCombinedEnd > 0
              ? embeddedCombinedEnd
              : embeddedCurrentEnd;
      } else if (final.startsWith(publicText)) publicText = final;
      else if (!publicText.trim() || consumed === 0) { publicText = final; consumed = 0; }
      else if (final.trim() !== publicText.trim()) {
        publicText = final;
        consumed = 0;
        return drain(true);
      }
      return drain(true);
    },
  };
}

/** Parse SSE incrementally, including UTF-8 and CRLF split across reads. */
export async function readAnswerEvents(response, onEvent, signal) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 256000) throw new Error("Voice event exceeded its size limit.");
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        let type = "message";
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!signal?.aborted && ["text", "run"].includes(type) && data.length) {
          let event;
          try { event = JSON.parse(data.join("\n")); } catch { continue; }
          onEvent(type, event);
        }
      }
      if (done) return true;
    }
    return true;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
