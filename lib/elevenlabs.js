// ElevenLabs TTS client with multi-key failover.
//
// We support a list of API keys (config.elevenlabsApiKeys). On every call we
// try them in order. Keys that 401/403 (invalid) or 429 (quota exhausted)
// get marked dead in-process so the next call skips them. The list is
// re-read from disk on every request, so adding a new key + restarting (or
// just editing the JSON) brings it back in without a redeploy.
//
// On total exhaustion (no live keys) we throw — the voice route then falls
// back to edge-tts so the user still hears something.

const DEFAULT_MODEL = "eleven_multilingual_v2";
// Settings cloned from the user's preferred Alexis Lancaster preset:
//   speed 1.03, stability 51%, similarity 75%, style 0%, speaker boost on.
const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stability: 0.51,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
  speed: 1.03,
});

// Process-wide bookkeeping for dead keys. Reset on server restart.
const deadKeys = new Map(); // apiKey -> { reason, deadAt }

function isDead(key) {
  return deadKeys.has(key);
}

function markDead(key, reason) {
  if (!key) return;
  deadKeys.set(key, { reason, deadAt: Date.now() });
}

function statusReason(status) {
  if (status === 401 || status === 403) return "invalid";
  if (status === 402 || status === 429) return "quota";
  return null;
}

function pickKeys(config) {
  // Accept either an array (`elevenlabsApiKeys`) or a single string
  // (`elevenlabsApiKey`). Both forms are filtered, deduped, and trimmed.
  const list = []
    .concat(Array.isArray(config?.elevenlabsApiKeys) ? config.elevenlabsApiKeys : [])
    .concat(typeof config?.elevenlabsApiKey === "string" ? [config.elevenlabsApiKey] : [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter(Boolean);
  // Dedupe while preserving order.
  const seen = new Set();
  const unique = list.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));

  // If a specific key is pinned active, hoist it to the front so it's tried
  // first by synthesizeWithFailover.
  const active =
    typeof config?.elevenlabsActiveKey === "string"
      ? config.elevenlabsActiveKey.trim()
      : "";
  if (active && unique.includes(active)) {
    return [active, ...unique.filter((k) => k !== active)];
  }
  return unique;
}

/**
 * Shared payload + key-rotation logic. The body is identical between buffered
 * and streaming requests; only the URL differs (`/...` vs `/.../stream`).
 */
function buildRequest({ text, voiceId, modelId, voiceSettings, config, streaming }) {
  const keys = pickKeys(config);
  if (keys.length === 0) {
    const e = new Error("No ElevenLabs API keys configured");
    e.kind = "no_keys";
    throw e;
  }
  const model = modelId || config?.elevenlabsModel || DEFAULT_MODEL;
  const voice = voiceId || config?.elevenlabsVoiceId;
  if (!voice) {
    const e = new Error("No ElevenLabs voice id configured");
    e.kind = "no_keys";
    throw e;
  }
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...(voiceSettings || {}) };
  const base = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`;
  // Streaming endpoint returns the same MP3 quality (mp3_44100_128) but
  // chunked, so the client can start playback on the first ~30KB.
  const url = streaming
    ? `${base}/stream?output_format=mp3_44100_128&optimize_streaming_latency=2`
    : `${base}?output_format=mp3_44100_128`;
  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: settings,
  });

  // First pass: try keys we still consider live.
  // Second pass: if every key looks "dead" (e.g. a stale probe wrongly killed
  // them all), retry the ones marked invalid/quota anyway. ElevenLabs is the
  // source of truth — a fresh 200 will clear the dead flag below.
  const livePass = keys.filter((k) => !isDead(k));
  const deadRetryPass = livePass.length === 0 ? keys.slice() : [];
  return { url, body, model, voice, orderedKeys: [...livePass, ...deadRetryPass] };
}

/**
 * Synthesize speech with ElevenLabs using whichever live key works first.
 * Returns the MP3 audio buffer plus metadata about which key was used.
 *
 * Throws an Error tagged with `kind` when nothing succeeds:
 *   - "no_keys" — config has no keys configured
 *   - "all_exhausted" — every configured key returned 401/403/429
 *   - "network" — every configured key threw a network/timeout error
 *   - "bad_request" — the API rejected the payload (4xx other than 401/403/429)
 */
export async function synthesizeWithFailover({ text, voiceId, modelId, voiceSettings, config }) {
  const { url, body, model, voice, orderedKeys } = buildRequest({
    text, voiceId, modelId, voiceSettings, config, streaming: false,
  });
  const errors = [];

  for (const key of orderedKeys) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body,
        signal: AbortSignal.timeout(45000),
      });
    } catch (err) {
      errors.push({
        key: key.slice(0, 8) + "…",
        reason: err && err.name === "AbortError" ? "timeout" : "network",
        message: err?.message || String(err),
      });
      continue;
    }

    if (res.ok) {
      // A real 200 from ElevenLabs is the strongest possible signal that the
      // key is fine — clear any prior dead mark.
      deadKeys.delete(key);
      const audio = Buffer.from(await res.arrayBuffer());
      return { audio, keyUsed: key, model, voiceId: voice };
    }

    const reason = statusReason(res.status);
    if (reason) {
      // 401/403/429 → mark this key dead, try the next.
      markDead(key, reason);
      errors.push({ key: key.slice(0, 8) + "…", status: res.status, reason });
      continue;
    }

    // Any other 4xx/5xx isn't a key problem — surface it immediately so we
    // don't burn through the rest of the keys retrying the same bad request.
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* noop */
    }
    const e = new Error(`ElevenLabs request failed (${res.status})`);
    e.kind = res.status >= 500 ? "network" : "bad_request";
    e.status = res.status;
    e.detail = detail;
    throw e;
  }

  // Every configured key was either dead or just failed.
  const allNetwork = errors.every((e) => e.reason === "network" || e.reason === "timeout");
  const e = new Error(allNetwork ? "All ElevenLabs keys unreachable" : "All ElevenLabs keys exhausted");
  e.kind = allNetwork ? "network" : "all_exhausted";
  e.errors = errors;
  throw e;
}

/**
 * Streaming variant. Same model, same voice settings, same MP3 quality
 * (mp3_44100_128) — only transport changes. We hit `/v1/text-to-speech/{id}/stream`
 * with `optimize_streaming_latency=2` so first audio bytes arrive within a few
 * hundred ms and the browser can start playback before synthesis is done.
 *
 * Returns `{ stream, keyUsed, model, voiceId }` where `stream` is a
 * web-platform `ReadableStream<Uint8Array>` ready to be piped into a Response.
 *
 * Throws the same `kind`-tagged errors as `synthesizeWithFailover`. Note that
 * we cannot fall back mid-stream: a key failure is only detected before the
 * 200 arrives, so the route still gets a clean error to fall through on.
 */
export async function synthesizeStreamWithFailover({ text, voiceId, modelId, voiceSettings, config, signal }) {
  const { url, body, model, voice, orderedKeys } = buildRequest({
    text, voiceId, modelId, voiceSettings, config, streaming: true,
  });
  const errors = [];
  const started = Date.now();

  for (const key of orderedKeys) {
    signal?.throwIfAborted();
    if (Date.now() - started > 10_000) break;
    let res;
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    const firstByteTimer = setTimeout(() => controller.abort(), 8000);
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body,
        signal: requestSignal,
      });
    } catch (err) {
      signal?.throwIfAborted();
      // A connection failure affects the service, not one key. Rotating the
      // whole pool used to multiply a single outage into a very long wait.
      const failure = new Error("Speech service could not connect.");
      failure.kind = "network";
      throw failure;
    } finally { clearTimeout(firstByteTimer); }

    if (res.ok && res.body) {
      deadKeys.delete(key);
      return { stream: res.body, keyUsed: key, model, voiceId: voice };
    }

    const reason = statusReason(res.status);
    if (reason) {
      await res.body?.cancel();
      markDead(key, reason);
      errors.push({ key: key.slice(0, 8) + "…", status: res.status, reason });
      continue;
    }

    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* noop */
    }
    const e = new Error(`ElevenLabs stream request failed (${res.status})`);
    e.kind = res.status >= 500 ? "network" : "bad_request";
    e.status = res.status;
    e.detail = detail;
    throw e;
  }

  const allNetwork = errors.every((e) => e.reason === "network" || e.reason === "timeout");
  const e = new Error(allNetwork ? "All ElevenLabs keys unreachable" : "All ElevenLabs keys exhausted");
  e.kind = allNetwork ? "network" : "all_exhausted";
  e.errors = errors;
  throw e;
}

/** Diagnostic helper for /api/voice/status if we want to surface key health later. */
export function snapshotKeyHealth(config) {
  const keys = pickKeys(config);
  return keys.map((k) => ({
    key: k.slice(0, 8) + "…",
    dead: isDead(k),
    reason: deadKeys.get(k)?.reason ?? null,
  }));
}

/** Helper for the voice settings UI to mask a key for display. */
export function maskKey(key) {
  if (!key) return "";
  const trimmed = String(key).trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * Probe a single key's TTS readiness, optionally enriched with credit usage.
 *
 * Step 1 (liveness, always): hit `/v1/voices` — this only requires the basic
 * TTS scope, which every key the user creates from the dashboard has by
 * default. If this 401/403s, the key is genuinely invalid.
 *
 * Step 2 (enrichment, best-effort): hit `/v1/user/subscription` for the
 * character quota. This requires the `User: Read` scope. If it 401s, we
 * still return ok:true with `reason:"tts-only"` and a note explaining the
 * credits panel needs that scope.
 *
 * On a successful liveness probe we proactively clear the in-process dead
 * flag so a key that was wrongly killed by a previous probe gets unstuck
 * automatically — no manual "Revive" needed.
 */
export async function probeKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) {
    return { key, masked: "", ok: false, status: 0, reason: "empty" };
  }
  const masked = maskKey(key);

  // ── Step 1: liveness via the most permissive scope ─────────────────
  // `/v1/user` works for any key with at least the `user_read` scope, which
  // ElevenLabs grants to every key by default — including TTS-only keys
  // created from the dashboard. Other endpoints (`/v1/voices`, `/v1/models`)
  // require their own scopes that aren't always enabled.
  let live;
  try {
    live = await fetch("https://api.elevenlabs.io/v1/user", {
      method: "GET",
      headers: { "xi-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return {
      key,
      masked,
      ok: false,
      status: 0,
      reason: err && err.name === "AbortError" ? "timeout" : "network",
      message: err?.message || String(err),
    };
  }

  if (!live.ok) {
    const reason = statusReason(live.status) || "http_error";
    if (reason === "invalid" || reason === "quota") markDead(key, reason);
    return { key, masked, ok: false, status: live.status, reason };
  }

  // Liveness passed → key is real and works for TTS. Clear any prior dead
  // mark so a stale "invalid" verdict from before doesn't keep blocking it.
  deadKeys.delete(key);

  // ── Step 2: credits enrichment (optional) ──────────────────────────
  let creds;
  try {
    creds = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      method: "GET",
      headers: { "xi-api-key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Network blip on enrichment — return liveness-only success.
    return {
      key,
      masked,
      ok: true,
      status: 200,
      reason: "tts-only",
      tier: null,
      used: null,
      limit: null,
      remaining: null,
      resetAt: null,
      note: "Credits hidden — User: Read permission disabled or unreachable.",
    };
  }

  if (!creds.ok) {
    return {
      key,
      masked,
      ok: true,
      status: 200,
      reason: "tts-only",
      tier: null,
      used: null,
      limit: null,
      remaining: null,
      resetAt: null,
      note:
        creds.status === 401 || creds.status === 403
          ? "Credits hidden — enable User: Read on this key in ElevenLabs to see usage."
          : `Credits unavailable (HTTP ${creds.status}).`,
    };
  }

  const data = await creds.json().catch(() => ({}));
  const used = Number.isFinite(data.character_count) ? data.character_count : null;
  const limit = Number.isFinite(data.character_limit) ? data.character_limit : null;
  const remaining = used != null && limit != null ? Math.max(0, limit - used) : null;
  const resetAt = Number.isFinite(data.next_character_count_reset_unix)
    ? data.next_character_count_reset_unix * 1000
    : null;

  // Zero remaining → mark dead so the failover skips it without burning a call.
  if (remaining === 0) markDead(key, "quota");

  return {
    key,
    masked,
    ok: true,
    status: 200,
    reason: isDead(key) ? deadKeys.get(key).reason : null,
    tier: data.tier || null,
    used,
    limit,
    remaining,
    resetAt,
  };
}

/** Probe every configured key in parallel. */
export async function probeAllKeys(config) {
  const keys = pickKeys(config);
  if (keys.length === 0) return [];
  return Promise.all(keys.map((k) => probeKey(k)));
}

/** Manually clear a key's "dead" flag — used by the "Revive" button in the UI. */
export function reviveKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return false;
  return deadKeys.delete(key);
}
