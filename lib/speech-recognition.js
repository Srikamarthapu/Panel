const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const TLS_CODES = new Set(["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN"]);

export function speechFailure(error) {
  const cause = String(error?.cause?.code || error?.code || error?.name || "NETWORK_ERROR");
  if (TLS_CODES.has(cause)) return { code: "STT_TLS_ERROR", message: "Speech recognition could not establish a secure connection. Check the computer’s clock or network certificate settings.", retryable: false, diagnostic: cause };
  if (error?.name === "TimeoutError") return { code: "STT_TIMEOUT", message: "Speech recognition timed out. You can retry this recording.", retryable: true, diagnostic: cause };
  return { code: "STT_NETWORK_ERROR", message: "Speech recognition could not connect. You can retry this recording or type your message.", retryable: true, diagnostic: cause };
}

export async function requestSpeechRecognition(url, options, { fetchImpl = fetch, wait = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason); };
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
}), timeoutMs = 12000 } = {}) {
  const { signal, ...requestOptions } = options;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(url, { ...requestOptions, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!TRANSIENT_STATUS.has(response.status) || attempt === 1) return response;
      try { await response.body?.cancel(); } catch { /* response already closed */ }
    } catch (error) {
      signal?.throwIfAborted();
      if (!speechFailure(error).retryable || attempt === 1) throw error;
    }
    await wait(350, signal);
  }
}
