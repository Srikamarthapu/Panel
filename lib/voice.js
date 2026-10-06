import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeStreamWithFailover } from "./elevenlabs.js";
import { MODEL_OPTIONS, readHermesEnv } from "./modelControl.js";
import { publicReplyText, publicReplyTokens } from "./publicReply.js";

const workspaceRoot = process.cwd();
const configPath = path.join(process.env.PANEL_DATA_DIR || path.join(workspaceRoot, "data"), "voice-config.json");
const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const hermesConfigPath = path.join(hermesHome, "config.yaml");
const memoryDir = path.join(hermesHome, "memories");

const VOICE_REPLY_MAX_CHARS = 800;
// T-0010 Law 8: completed data/action answers are the full spoken reply and
// must not be amputated at the fast-path reply length. sanitizeForVoice accepts
// a per-call cap; the completion path passes this larger ceiling so a real
// tool-backed answer speaks in full, while the fast path keeps 800.
const VOICE_COMPLETION_MAX_CHARS = 2000;
const MEMORY_TOTAL_MAX_CHARS = 2400;
const MEMORY_FILE_MAX_CHARS = 1200;
const FIRST_CHUNK_MAX_CHARS = 180;

// ── TTS chunk coalescing (T-0009 fix A) ───────────────────────────────────
// ElevenLabs prosody quality drops sharply when a reply is synthesized as many
// short isolated fragments — each /stream request resets the model's prosodic
// context, so "Got it." and "All tests are green." lose the natural sentence
// flow they'd have if spoken together, and the chunk joins can click/gap in
// the MediaSource playback path. The old "crisp" sound was whole-reply
// single-shot synthesis.
//
// So we coalesce whole sentences before each TTS request, balancing crispness
// against first-audio latency:
//
//   • The FIRST chunk flushes at the first sentence boundary once it reaches
//     TTS_FIRST_CHUNK_MIN chars — roughly one natural sentence, never a clicky
//     "Got it." fragment. This keeps first-audio fast on longer replies
//     (audio starts as soon as sentence one is complete, not after the whole
//     reply streams). A short whole reply below this floor never crosses it,
//     so it's spoken as ONE crisp single-shot synthesis on drain.
//
//   • SUBSEQUENT chunks coalesce up to TTS_CHUNK_TARGET chars (2–3 sentences)
//     per request instead of one-per-sentence, so the bulk of a long reply is
//     synthesized in a few large, natural-sounding pieces.
//
// Boundaries are always sentence-final — we never split mid-clause.
const TTS_FIRST_CHUNK_MIN_CHARS = 90;
const TTS_CHUNK_TARGET_CHARS = 240;

const PROVIDER_DEFAULTS = Object.freeze({
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
  },
});

const defaults = {
  // ── Text-to-speech ────────────────────────────────────────────────────
  // Backends: "elevenlabs" (preferred when a key is configured), "edge-tts"
  // (free fallback / no-key default).
  ttsBackend: process.env.ELEVENLABS_API_KEY ? "elevenlabs" : "edge-tts",
  ttsVoice: "en-US-AriaNeural",
  ttsRate: "+0%",
  ttsPitch: "+0Hz",
  ttsVolume: "+0%",

  // ── ElevenLabs (Alexis Lancaster preset) ──────────────────────────────
  // Multi-key failover: the route tries each key in order, marks 401/403/429
  // keys dead in-process, and falls back to edge-tts when the list is empty.
  elevenlabsApiKeys: process.env.ELEVENLABS_API_KEY ? [process.env.ELEVENLABS_API_KEY.trim()] : [],
  elevenlabsActiveKey: "",
  elevenlabsVoiceId: "pFZP5JQG7iQjIQuC4Bku",
  elevenlabsModel: "eleven_multilingual_v2",
  elevenlabsVoiceSettings: {
    stability: 0.51,
    similarity_boost: 0.75,
    style: 0.0,
    use_speaker_boost: true,
    speed: 1.03,
  },

  // ── Speech-to-text (Deepgram cloud API) ────────────────────────────
  sttBackend: "deepgram",
  sttLanguage: "en",        // ISO-639 code, or "auto"

  // ── Voice chat model override ─────────────────────────────────────────
  // Empty strings mean "use the normal Hermes model". These apply only to
  // voice turns and do not rewrite ~/.hermes/config.yaml.
  voiceModelProvider: "",
  voiceModel: "",
  voiceReasoningEffort: "low",

  // ── UX ─────────────────────────────────────────────────────────────────
  autoSpeak: true,
  enabled: true,
  micDeviceId: "",
  speakerDeviceId: "",
  muteOutput: false,

  // ── Discord mirror (optional) ─────────────────────────────────────────
  // When set, each voice turn is mirrored to a Discord channel via two
  // webhooks: the user webhook posts as "You", Hermes' webhook posts as
  // "Hermes". Leave blank to disable. URLs are stored locally only.
  discordUserWebhook: "",
  discordHermesWebhook: "",
};

/**
 * Read the current voice configuration, merged with defaults.
 */
export function getVoiceConfig() {
  try {
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ configPath, "utf8");
    const saved = JSON.parse(raw);
    const config = { ...defaults, ...saved };
    if (!config.elevenlabsApiKeys?.length && process.env.ELEVENLABS_API_KEY?.trim()) {
      config.elevenlabsApiKeys = [process.env.ELEVENLABS_API_KEY.trim()];
    }
    return config;
  } catch {
    return { ...defaults };
  }
}

/**
 * Save voice configuration (partial update merged with existing).
 */
export function saveVoiceConfig(partial) {
  const current = getVoiceConfig();
  const merged = { ...current, ...partial };
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, 0o600);
  return merged;
}

/**
 * Construct the ephemeral voice system prompt for Hermes CLI.
 * Plain prose only — no bracketed stage directions.
 */
export function getVoiceSystemPrompt() {
  return `You are speaking with the user out loud through a local voice interface (Whisper STT in, edge-tts neural voice out). You are NOT typing into a chat window.

Hard rules — your response will be spoken verbatim by a text-to-speech engine, so violations are heard as gibberish:

1. Plain conversational prose only. NO markdown of any kind: no asterisks, no underscores, no backticks, no pound signs, no bullet points, no dashes used as list markers, no numbered lists.
2. NO tables, NO code blocks, NO URLs, NO file paths, NO IDs, NO long strings of digits. If you must reference one, summarize it ("the project doc") instead of reading it aloud.
3. NO bracketed stage directions, emotion tags, prosody markers, or emoji. The synthesizer reads them literally.
4. Keep replies SHORT — one to three sentences in most cases. If the user asks something that genuinely needs a list, speak it as a flowing sentence ("first X, then Y, and finally Z") rather than a bulleted list.
5. NEVER narrate internal status: do not say "Reached maximum iterations", "Requesting summary", "Calling tool X", "Tool returned …", or any system banner. If a tool ran, just speak the human-friendly result.
6. The user's input came from speech-to-text and may contain typos or missing punctuation. Interpret charitably; do not nitpick wording.
7. Address the user the way you would in a real conversation. You are talking, not writing a report.

When in doubt, sound like a calm, knowledgeable friend giving a quick answer.`;
}

function cleanScalar(value) {
  return String(value == null ? "" : value).trim().replace(/^["']|["']$/g, "");
}

function clipAtBoundary(text, limit) {
  const source = String(text || "").trim();
  if (source.length <= limit) return source;
  const boundary = Math.max(
    source.lastIndexOf("\n", limit),
    source.lastIndexOf(". ", limit),
    source.lastIndexOf("; ", limit),
  );
  return `${source.slice(0, boundary > limit * 0.45 ? boundary + 1 : limit).trim()} ...`;
}

function compactMemoryText(raw, limit) {
  return clipAtBoundary(
    String(raw || "")
      .replace(/\r/g, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    limit,
  );
}

/**
 * Read a compact local Hermes memory snapshot for direct voice-model calls.
 * This intentionally avoids an LLM summarization step; voice latency matters.
 */
export function getHermesMemorySnapshot({
  dir = memoryDir,
  totalLimit = MEMORY_TOTAL_MAX_CHARS,
  perFileLimit = MEMORY_FILE_MAX_CHARS,
} = {}) {
  const parts = [];
  for (const name of ["USER.md", "MEMORY.md"]) {
    try {
      const full = path.join(/*turbopackIgnore: true*/ dir, name);
      const body = compactMemoryText(fs.readFileSync(/*turbopackIgnore: true*/ full, "utf8"), perFileLimit);
      if (body) parts.push(`${name}:\n${body}`);
    } catch {
      /* memory is optional */
    }
  }
  if (parts.length === 0) return "";
  return clipAtBoundary(`Hermes memory snapshot:\n${parts.join("\n\n")}`, totalLimit);
}

export function getVoiceSystemPromptWithMemory(options = {}) {
  const snapshot = getHermesMemorySnapshot(options);
  const base = getVoiceSystemPrompt();
  return snapshot ? `${snapshot}\n\n${base}` : base;
}

function readHermesModelDefaults() {
  try {
    const lines = fs.readFileSync(/*turbopackIgnore: true*/ hermesConfigPath, "utf8").split(/\r?\n/);
    const out = {};
    let inModel = false;
    for (const line of lines) {
      if (/^\S/.test(line)) inModel = line.trim() === "model:";
      if (!inModel) continue;
      const defaultMatch = line.match(/^\s+default:\s*(.+?)\s*$/);
      const providerMatch = line.match(/^\s+provider:\s*(.+?)\s*$/);
      const baseMatch = line.match(/^\s+base_url:\s*(.+?)\s*$/);
      if (defaultMatch) out.model = cleanScalar(defaultMatch[1]);
      if (providerMatch) out.provider = cleanScalar(providerMatch[1]);
      if (baseMatch) out.baseUrl = cleanScalar(baseMatch[1]);
    }
    return out;
  } catch {
    return {};
  }
}

export function resolveVoiceModelConfig(config = {}) {
  const hermesDefault = readHermesModelDefaults();
  const provider = cleanScalar(config.voiceModelProvider) || hermesDefault.provider;
  const model = cleanScalar(config.voiceModel) || hermesDefault.model;
  const known = MODEL_OPTIONS.find(
    (option) => option.provider === provider && option.model === model,
  );
  const providerDefault = PROVIDER_DEFAULTS[provider] || {};
  const baseUrl = known?.baseUrl || hermesDefault.baseUrl || providerDefault.baseUrl;
  const envKey = known?.envKey || providerDefault.envKey;
  const env = { ...readHermesEnv(), ...process.env };
  const apiKey = envKey ? env[envKey] : "";

  if (!provider || !model || !baseUrl || !envKey) {
    const error = new Error("Voice model provider/model is not configured for direct API use.");
    error.code = "voice_model_config";
    error.detail = { provider: provider || "", model: model || "" };
    throw error;
  }
  if (!apiKey) {
    const error = new Error(`${envKey} is not configured.`);
    error.code = "voice_model_key";
    error.envKey = envKey;
    throw error;
  }

  return {
    provider,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    envKey,
    apiKey,
    label: `${provider}/${model}`,
  };
}

/**
 * Scrub model text into something safe to hand to TTS.
 */
export function sanitizeForVoice(raw, options = {}) {
  if (!raw) return "";
  let text = publicReplyText(raw);
  const maxChars =
    Number.isFinite(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : VOICE_REPLY_MAX_CHARS;

  text = text.replace(/^\s*⚠️?\s*Reached maximum iterations[^\n]*\n?/gim, "");
  text = text.replace(/^\s*Requesting summary\.{0,3}\s*/gim, "");
  text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/(^|\W)_([^_]+)_(\W|$)/g, "$1$2$3");
  text = text.replace(/^\s*#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*•]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/https?:\/\/\S+/gi, "(link)");
  text = text.replace(/\b(?:\/[\w.\-/]+){2,}/g, "(path)");
  text = text.replace(/[⚠️✓✅❌⛔🚫🟢🟡🔴⏱⏲]/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\s*\n\s*\n\s*/g, "\n\n");
  text = text.trim();

  if (text.length > maxChars) {
    // Prefer a sentence boundary so the spoken reply ends on a full thought
    // instead of a mid-word cut. Fall back to a hard slice only if no late
    // sentence break exists.
    const cut = text.lastIndexOf(". ", maxChars);
    text = (cut > 200 ? text.slice(0, cut + 1) : text.slice(0, maxChars)).trim();
  }
  return text;
}

// ── Data lane (T-0008) ────────────────────────────────────────────────────
// Questions that need the user's REAL personal data/tools (calendar, email,
// Notion, tasks, reminders, files) must NOT go to the bare fast path — the
// flash model has no tools and confidently hallucinates ("what's on my
// calendar?" → invented events). Instead they route to the "data" lane: a
// short spoken filler ships immediately for latency, and the same detached
// Hermes runner answers the question WITH tools, spoken back when it lands.
//
// This stays deterministic (regex/keyword table, no LLM) to keep classifier
// latency at zero. Each topic maps a personal-data noun to a spoken filler
// and a present-tense live-status label. When a topic's noun appears in the
// utterance AND the utterance reads as a question/request (question word,
// trailing "?", or a possessive like "my"/"check"), we err toward the data
// lane — a hallucinated personal answer is worse than one filler line.
const DATA_LANE_TOPICS = Object.freeze([
  {
    topic: "calendar",
    // Word-boundary keywords; multiword phrases matched as substrings below.
    keywords: ["calendar", "schedule", "meeting", "meetings", "event", "events", "appointment", "appointments", "agenda"],
    filler: "Let me check your calendar.",
    status: "Checking your calendar…",
  },
  {
    topic: "email",
    keywords: ["email", "emails", "inbox", "gmail", "mail", "unread"],
    filler: "Let me check your inbox.",
    status: "Checking your inbox…",
  },
  {
    topic: "notion",
    keywords: ["notion", "notes", "note", "doc", "docs", "document", "documents", "page", "pages"],
    filler: "Let me look that up in Notion.",
    status: "Searching your Notion…",
  },
  {
    topic: "tasks",
    keywords: ["task", "tasks", "todo", "todos", "to-do", "reminder", "reminders", "task list", "to do"],
    filler: "Let me pull up your tasks.",
    status: "Checking your tasks…",
  },
  {
    topic: "files",
    keywords: ["file", "files", "folder", "folders", "download", "downloads"],
    filler: "Let me look through your files.",
    status: "Searching your files…",
  },
]);

const DATA_LANE_DEFAULT = Object.freeze({
  topic: "personal",
  filler: "Let me look that up for you.",
  status: "Looking that up…",
});

// Signals that an utterance is a QUESTION or personal request rather than a
// bare command. "what do I have", "what's on my", "check my", "do I have",
// question words, a trailing question mark, or a first-person possessive.
const DATA_QUESTION_HINT = new RegExp(
  "(^|\\b)(what|when|whats|what's|when's|whens|do i|did i|is there|are there|" +
    "how many|any|show me|list|read|tell me|check|any new|anything)\\b|" +
    "\\bmy\\b|\\?\\s*$",
  "i",
);

function matchDataTopic(normalized) {
  for (const entry of DATA_LANE_TOPICS) {
    for (const keyword of entry.keywords) {
      const pattern = keyword.includes(" ")
        ? new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
        : new RegExp(`\\b${keyword}\\b`, "i");
      if (pattern.test(normalized)) return entry;
    }
  }
  return null;
}

/**
 * Spoken filler for a data-lane topic ("Let me check your calendar."), safe
 * to hand straight to TTS. Falls back to a generic line for unknown topics.
 */
export function dataLaneFiller(topic) {
  const entry = DATA_LANE_TOPICS.find((t) => t.topic === topic);
  return (entry || DATA_LANE_DEFAULT).filler;
}

/**
 * Present-tense live-status label for a data-lane topic ("Checking your
 * calendar…"), shown in the dock while the Hermes run is in flight (T-0008
 * fix C). Falls back to a generic present-tense label.
 */
export function dataLaneStatusLabel(topic) {
  const entry = DATA_LANE_TOPICS.find((t) => t.topic === topic);
  return (entry || DATA_LANE_DEFAULT).status;
}

/**
 * Present-tense live-status label for a plain action utterance ("Opening
 * Notion…", "Running the build…"), derived from the utterance verb/object.
 * Used by the action runner so the dock shows what Hermes is doing right now.
 */
export function actionStatusLabel(text) {
  const normalized = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return "Working on that…";
  // "open notion" / "open the browser" → "Opening notion…"
  const openMatch = normalized.match(/\bopen\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9 .-]{0,30})/i);
  if (openMatch) {
    const object = openMatch[1].replace(/[.?!]+$/g, "").trim();
    const capped = object.charAt(0).toUpperCase() + object.slice(1);
    return `Opening ${capped}…`;
  }
  const verbMap = [
    [/\b(run|execute)\b/, "Running that…"],
    [/\b(build|compile)\b/, "Building that…"],
    [/\b(test|check|verify|lint|typecheck)\b/, "Checking that…"],
    [/\b(deploy|install)\b/, "Setting that up…"],
    [/\b(fix|create|update|change|edit|implement|refactor)\b/, "Working on that…"],
    [/\b(review|inspect|investigate)\b/, "Looking into that…"],
    [/\b(restart|stop|start)\b/, "On it…"],
  ];
  for (const [pattern, label] of verbMap) {
    if (pattern.test(normalized)) return label;
  }
  return "Working on that…";
}

export function classifyVoiceIntent(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalized) return { type: "chat", action: false };

  const commandVerb =
    "(build|run|execute|start|restart|stop|test|check|lint|typecheck|compile|deploy|install|fix|create|update|change|edit|implement|refactor|review|verify|inspect|investigate|open)";
  const direct = new RegExp(`^(please\\s+)?${commandVerb}\\b`, "i");
  const polite = new RegExp(`^(can|could|would)\\s+you\\s+${commandVerb}\\b`, "i");
  const wakeWord = new RegExp(`^hermes\\s*,?\\s*${commandVerb}\\b`, "i");
  const action = direct.test(normalized) || polite.test(normalized) || wakeWord.test(normalized);

  const dataTopic = matchDataTopic(normalized);

  // A "soft" reading verb ("check my email", "read my inbox", "show my
  // calendar", "find my notion notes") overlaps the command-verb list but is
  // really a personal-data QUESTION that needs tools, not a build/lint action.
  // When such a verb leads AND a personal-data noun is present, the data lane
  // wins over the action lane. Hard verbs (open/build/run/deploy/…) never do,
  // so "open notion" stays a plain app-launch action.
  const softDataVerb = /^(please\s+|(can|could|would)\s+you\s+|hermes\s*,?\s*)?(check|read|show|find|list|look|get|pull|see)\b/i;
  if (dataTopic && softDataVerb.test(normalized)) {
    return {
      type: "data",
      action: true,
      dataTopic: dataTopic.topic,
      filler: dataTopic.filler,
      statusLabel: dataTopic.status,
    };
  }

  if (action) {
    return { type: "action", action: true, statusLabel: actionStatusLabel(normalized) };
  }

  // Data lane: a personal-data noun plus a question/request shape. This runs
  // after the command-verb check so a hard action verb still wins, but before
  // falling through to chat so "what's on my calendar?" never reaches the
  // tool-less flash model.
  if (dataTopic && DATA_QUESTION_HINT.test(normalized)) {
    return {
      type: "data",
      action: true,
      dataTopic: dataTopic.topic,
      filler: dataTopic.filler,
      statusLabel: dataTopic.status,
    };
  }

  return { type: "chat", action: false };
}

export function voiceActionAck(text) {
  const task = sanitizeForVoice(text)
    .replace(/[.?!]+$/g, "")
    .slice(0, 90)
    .trim();
  return task ? `On it. Running ${task} now.` : "On it. Running that now.";
}

function extractSsePayloads(buffer) {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() || "";
  const payloads = [];
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (data) payloads.push(data);
  }
  return { payloads, rest };
}

async function* streamVoiceModelRawTokens({
  text,
  config,
  fetchImpl = fetch,
  signal,
  systemPrompt = getVoiceSystemPromptWithMemory(),
  onFirstToken,
  history = [],
} = {}) {
  const resolved = resolveVoiceModelConfig(config);
  const response = await fetchImpl(`${resolved.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: resolved.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
          .slice(-12).map((message) => ({
            role: message.role,
            content: (message.role === "assistant" ? publicReplyText(message.content) : message.content).slice(0, 4000),
          })).filter((message) => message.content.trim()),
        { role: "user", content: text },
      ],
      stream: true,
      temperature: 0.4,
      max_tokens: 220,
    }),
    signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      /* noop */
    }
    const error = new Error(`Voice model request failed (${response.status})`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Voice model did not return a readable stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawFirst = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const extracted = extractSsePayloads(buffer);
    buffer = extracted.rest;
    for (const payload of extracted.payloads) {
      if (payload === "[DONE]") return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const token =
        parsed?.choices?.[0]?.delta?.content ??
        parsed?.choices?.[0]?.text ??
        "";
      if (!token) continue;
      if (!sawFirst) {
        sawFirst = true;
        if (typeof onFirstToken === "function") onFirstToken();
      }
      yield token;
    }
  }

  // Drain any trailing frame the provider emitted without a closing blank
  // line (e.g. the last data: chunk before EOF). Without this, the final
  // token of every reply is silently dropped.
  buffer += decoder.decode();
  if (buffer.trim()) {
    const final = extractSsePayloads(`${buffer}\n\n`);
    for (const payload of final.payloads) {
      if (payload === "[DONE]") return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const token =
        parsed?.choices?.[0]?.delta?.content ??
        parsed?.choices?.[0]?.text ??
        "";
      if (!token) continue;
      if (!sawFirst) {
        sawFirst = true;
        if (typeof onFirstToken === "function") onFirstToken();
      }
      yield token;
    }
  }
}

export async function* streamVoiceModelTokens(options = {}) {
  yield* publicReplyTokens(streamVoiceModelRawTokens(options));
}

export async function collectVoiceModelText(options = {}) {
  let response = "";
  for await (const token of streamVoiceModelTokens(options)) {
    response += token;
  }
  return sanitizeForVoice(response);
}

export function takeVoiceSentenceChunk(buffer, { force = false } = {}) {
  const source = String(buffer || "").replace(/\s+/g, " ").trimStart();
  if (!source.trim()) return null;

  for (let i = 0; i < source.length; i += 1) {
    if (!/[.!?。！？]/.test(source[i])) continue;
    const next = source[i + 1] || "";
    // Full-width CJK punctuation (。！？) always ends a sentence regardless
    // of what follows — these scripts do not use spaces after punctuation.
    // For ASCII punctuation (., !, ?), we require whitespace or end-of-string
    // to avoid splitting on abbreviations like "Dr.".
    const isFullWidthPunct = /[。！？]/.test(source[i]);
    if (i >= 2 && (isFullWidthPunct || !next || /\s/.test(next))) {
      return {
        chunk: source.slice(0, i + 1).trim(),
        rest: source.slice(i + 1).trimStart(),
      };
    }
  }

  if (source.length >= FIRST_CHUNK_MAX_CHARS) {
    const window = source.slice(80, FIRST_CHUNK_MAX_CHARS);
    const punctuation = Math.max(window.lastIndexOf(","), window.lastIndexOf(";"), window.lastIndexOf(":"));
    const space = window.lastIndexOf(" ");
    const offset = punctuation >= 0 ? punctuation : space;
    if (offset >= 0) {
      const index = 80 + offset + 1;
      return {
        chunk: source.slice(0, index).trim(),
        rest: source.slice(index).trimStart(),
      };
    }
  }

  if (force) {
    return { chunk: source.trim(), rest: "" };
  }
  return null;
}

/**
 * Coalescing chunker for the streaming fast path (T-0009 fix A).
 *
 * Instead of emitting one TTS request per sentence, this accumulates whole
 * sentences (via takeVoiceSentenceChunk) until the buffer reaches the flush
 * threshold, then flushes them as a SINGLE chunk so ElevenLabs synthesizes
 * them together with natural cross-sentence prosody. Boundaries are always
 * sentence-final — we never split mid-clause.
 *
 * The FIRST chunk uses a small threshold (firstChunkMin) so audio starts
 * quickly on a longer reply — it flushes at the first sentence boundary once
 * it reaches ~one natural sentence, never a clicky fragment. A short whole
 * reply below that floor never crosses it, so it drains as ONE single-shot
 * synthesis. Subsequent chunks fill to targetChars so long replies are spoken
 * in a few large requests.
 *
 * Returns { chunk, rest } when a full-size chunk is ready, or null when the
 * buffer isn't full enough yet (unless `force`, which flushes whatever whole
 * sentences are buffered, plus the raw remainder).
 */
export function takeVoiceTtsChunk(
  buffer,
  {
    force = false,
    isFirst = false,
    targetChars = TTS_CHUNK_TARGET_CHARS,
    firstChunkMin = TTS_FIRST_CHUNK_MIN_CHARS,
  } = {},
) {
  const source = String(buffer || "");
  if (!source.trim()) {
    return null;
  }

  let acc = "";
  let rest = source;
  const threshold = isFirst ? firstChunkMin : targetChars;

  while (true) {
    const next = takeVoiceSentenceChunk(rest);
    if (!next) break;
    acc = acc ? `${acc} ${next.chunk}` : next.chunk;
    rest = next.rest;
    // Flush once we've gathered enough spoken material to synthesize as one
    // natural utterance. We stop at the first sentence boundary that crosses
    // the threshold so we never chop mid-clause.
    if (acc.length >= threshold) {
      return { chunk: acc.trim(), rest: rest.trimStart() };
    }
  }

  if (force) {
    // Drain: flush any buffered whole sentences plus the trailing remainder
    // (the model's final fragment that never got a closing punctuation).
    const tail = rest.trim();
    const combined = acc && tail ? `${acc} ${tail}` : acc || tail;
    return combined ? { chunk: combined.trim(), rest: "" } : null;
  }

  // Not enough buffered yet and more tokens may still arrive — hold.
  return null;
}

async function pipeTtsStream({
  controller,
  text,
  config,
  synthesizeStreamImpl,
  onFirstAudioByte,
  state,
}) {
  const speakable = sanitizeForVoice(text);
  if (!speakable) return;
  const { stream } = await synthesizeStreamImpl({
    text: speakable,
    voiceId: config.elevenlabsVoiceId,
    modelId: config.elevenlabsModel,
    voiceSettings: config.elevenlabsVoiceSettings,
    config,
  });
  if (!stream || typeof stream.getReader !== "function") {
    throw new Error("TTS did not return a readable stream.");
  }
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.byteLength) continue;
    if (!state.sawAudioByte) {
      state.sawAudioByte = true;
      if (typeof onFirstAudioByte === "function") onFirstAudioByte();
    }
    controller.enqueue(value);
  }
}

export function createVoiceAudioStream({
  text,
  config,
  fetchImpl = fetch,
  synthesizeStreamImpl = synthesizeStreamWithFailover,
  signal,
  onFirstToken,
  onFirstAudioByte,
  onComplete,
  onError,
  history,
} = {}) {
  const state = { sawAudioByte: false };
  let fullResponse = "";

  return new ReadableStream({
    async start(controller) {
      let pending = "";
      // First chunk flushes earlier (smaller) to keep first-audio latency low;
      // later chunks fill closer to the target so the bulk of the reply is
      // synthesized in a few large, natural-sounding requests instead of one
      // per sentence (T-0009 fix A — crispness).
      let isFirst = true;
      try {
        for await (const token of streamVoiceModelTokens({
          text,
          config,
          fetchImpl,
          signal,
          onFirstToken,
          history,
        })) {
          fullResponse += token;
          pending += token;
          while (true) {
            const next = takeVoiceTtsChunk(pending, { isFirst });
            if (!next) break;
            pending = next.rest;
            isFirst = false;
            await pipeTtsStream({
              controller,
              text: next.chunk,
              config,
              synthesizeStreamImpl,
              onFirstAudioByte,
              state,
            });
          }
        }
        // Drain the remainder as one final chunk. For a short whole reply that
        // never crossed the flush threshold, this is the ONLY synthesis call —
        // the reply is spoken in a single request, restoring the crisp
        // whole-utterance prosody.
        const finalChunk = takeVoiceTtsChunk(pending, { force: true, isFirst });
        if (finalChunk?.chunk) {
          await pipeTtsStream({
            controller,
            text: finalChunk.chunk,
            config,
            synthesizeStreamImpl,
            onFirstAudioByte,
            state,
          });
        }
        controller.close();
        if (typeof onComplete === "function") {
          onComplete({ response: sanitizeForVoice(fullResponse) });
        }
      } catch (error) {
        if (typeof onError === "function") onError(error);
        if (typeof onComplete === "function") {
          onComplete({ response: sanitizeForVoice(fullResponse), error });
        }
        controller.error(error);
      }
    },
  });
}

export function createVoiceAckAudioStream({
  text,
  config,
  synthesizeStreamImpl = synthesizeStreamWithFailover,
  onFirstAudioByte,
  onComplete,
  onError,
} = {}) {
  const state = { sawAudioByte: false };
  const response = sanitizeForVoice(text);
  return new ReadableStream({
    async start(controller) {
      try {
        await pipeTtsStream({
          controller,
          text: response,
          config,
          synthesizeStreamImpl,
          onFirstAudioByte,
          state,
        });
        controller.close();
        if (typeof onComplete === "function") onComplete({ response });
      } catch (error) {
        if (typeof onError === "function") onError(error);
        if (typeof onComplete === "function") onComplete({ response, error });
        controller.error(error);
      }
    },
  });
}
