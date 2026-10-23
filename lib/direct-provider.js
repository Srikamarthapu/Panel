import crypto from "node:crypto";
import { DIRECT_PROVIDERS, resolveDirectProvider } from "./direct-config.js";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_OUTPUT_CHARS = 64_000;
const publicErrors = new WeakMap();
const CREDENTIAL_CHANGED_MESSAGE = "The saved provider credential changed after this request was accepted. Retry the request so Panel can use the current key.";

function publicError(message, status = null) {
  const error = new Error(message);
  publicErrors.set(error, Number.isInteger(status) ? status : null);
  return error;
}

// Provider response bodies and transport exceptions are untrusted. Only
// errors constructed in this module may cross an API or runner boundary.
export function directProviderPublicMessage(error, fallback) {
  return error && publicErrors.has(error) ? error.message : fallback;
}

export function directProviderPublicStatus(error, fallback = 502) {
  return error && publicErrors.has(error) ? publicErrors.get(error) || fallback : fallback;
}

export function resolveDirectProviderForRequest(providerId) {
  try { return resolveDirectProvider(providerId); }
  catch (error) {
    if (error?.status) throw publicError(error.message, error.status);
    throw error;
  }
}

export function directCredentialFingerprint(apiKey) {
  return crypto.createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function resolveDirectProviderForAcceptedRequest(providerId, expectedFingerprint) {
  let connection;
  try { connection = resolveDirectProvider(providerId); }
  catch (error) {
    if (error?.status) throw publicError(CREDENTIAL_CHANGED_MESSAGE, 409);
    throw error;
  }
  const actual = Buffer.from(directCredentialFingerprint(connection.apiKey), "hex");
  const validExpected = typeof expectedFingerprint === "string" && /^[a-f0-9]{64}$/.test(expectedFingerprint);
  const expected = validExpected ? Buffer.from(expectedFingerprint, "hex") : Buffer.alloc(actual.length);
  if (!crypto.timingSafeEqual(actual, expected) || !validExpected) throw publicError(CREDENTIAL_CHANGED_MESSAGE, 409);
  return connection;
}

function headers(apiKey, provider) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(provider.id === "openrouter" ? { "HTTP-Referer": "https://panel.local", "X-Title": "Panel" } : {}),
  };
}

async function readBounded(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel(); } catch {}
    throw publicError("The provider returned more data than Panel can safely read.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw publicError("The provider returned more data than Panel can safely read.");
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function safeProviderError(status) {
  if (status === 401 || status === 403) return publicError("The provider rejected this API key. Check the saved key and try again.");
  if (status === 404) return publicError("The provider could not find that model or endpoint. Refresh the model list and choose an available model.");
  if (status === 429) return publicError("The provider rate limit or account quota was reached. Check the provider account and try again.");
  if (status === 400 || status === 422) return publicError("The provider rejected the model or request. Refresh the model list and check the selected model ID.");
  if (status >= 500) return publicError("The provider is temporarily unavailable. Try again in a moment.");
  return publicError(`The provider request failed with status ${status}.`);
}

function providerUrl(provider, pathname) {
  const url = new URL(pathname, provider.origin);
  if (url.protocol !== "https:" || url.origin !== provider.origin) throw new Error("Direct provider destination is not allowed.");
  return url;
}

async function providerFetch(url, options, { fetchImpl = fetch, timeoutMs = 30_000 } = {}, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(publicError("The provider request timed out.")), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(url, { ...options, redirect: "error", signal });
    return await consume(response);
  }
  catch (error) {
    // Body readers commonly replace an AbortSignal reason with a generic
    // AbortError. Preserve Panel's own safe timeout message, while leaving
    // transport and caller-abort details private at the boundary.
    if (controller.signal.aborted) throw controller.signal.reason;
    controller.abort();
    throw error;
  }
  finally { clearTimeout(timer); }
}

export async function listDirectModels(providerId, options = {}) {
  const connection = resolveDirectProviderForRequest(providerId);
  return providerFetch(providerUrl(connection.provider, connection.provider.modelsPath), {
    method: "GET",
    headers: headers(connection.apiKey, connection.provider),
  }, options, async response => {
    const text = await readBounded(response, response.ok ? MAX_CATALOG_BYTES : MAX_ERROR_BYTES);
    if (!response.ok) throw safeProviderError(response.status);
    let payload;
    try { payload = JSON.parse(text); } catch { throw publicError("The provider returned an unreadable model catalog."); }
    const seen = new Set();
    return (Array.isArray(payload?.data) ? payload.data : []).flatMap(item => {
      const id = typeof item?.id === "string" ? item.id.trim() : "";
      if (!id || id.length > 300 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) return [];
      seen.add(id);
      const label = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 300) : id;
      return [{ id, label, owner: typeof item.owned_by === "string" ? item.owned_by.slice(0, 120) : "" }];
    });
  });
}

function usageFrom(value) {
  const inputTokens = Number(value?.prompt_tokens ?? value?.input_tokens);
  const outputTokens = Number(value?.completion_tokens ?? value?.output_tokens);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) return undefined;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd: null };
}

export async function streamDirectCompletion({ provider, model, apiKey, messages, signal, onDelta = () => {} }, options = {}) {
  const id = typeof provider === "string" ? provider : provider?.id;
  const definition = Object.hasOwn(DIRECT_PROVIDERS, id) ? DIRECT_PROVIDERS[id] : null;
  if (!definition) throw new Error("Direct provider destination is not allowed.");
  return providerFetch(providerUrl(definition, definition.chatPath), {
    method: "POST",
    headers: headers(apiKey, definition),
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
    signal,
  }, { ...options, timeoutMs: options.timeoutMs || 5 * 60_000 }, async response => {
    if (!response.ok) { await readBounded(response, MAX_ERROR_BYTES); throw safeProviderError(response.status); }
    if (!response.body) throw publicError("The provider returned an empty response.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", output = "", usage, doneMarker = false, finishReason = "";
    const consumeLine = line => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data) return;
      if (data === "[DONE]") { doneMarker = true; return; }
      let event;
      try { event = JSON.parse(data); } catch { throw publicError("The provider stream contained an unreadable event."); }
      if (event.error) throw publicError("The provider reported an error while generating the answer. Try again.");
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta) {
        if (output.length + delta.length > MAX_OUTPUT_CHARS) throw publicError("The provider response exceeded Panel's conversation limit.");
        output += delta;
        onDelta(delta, output);
      }
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
      usage = usageFrom(event.usage) || usage;
    };
    try {
      while (!doneMarker) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 256_000) throw publicError("The provider stream contained an oversized event.");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) consumeLine(line);
      if (!doneMarker || !finishReason) throw publicError("The provider connection ended before the answer was complete. Any text received is incomplete. Retry the request.");
      if (finishReason === "length") throw publicError("The provider stopped at its output limit before finishing the answer. Choose a model with a larger output limit or ask for a shorter answer.");
      if (finishReason === "content_filter") throw publicError("The provider stopped the answer because of its content policy.");
      if (finishReason !== "stop") throw publicError("The provider stopped with an unsupported completion status. Direct mode did not run any tools.");
      if (!output.trim()) throw publicError("The provider returned no answer.");
      return { response: output, usage };
    } finally {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  });
}
