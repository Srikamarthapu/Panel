export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size.");
    this.name = "RequestBodyTooLargeError";
    this.code = "REQUEST_BODY_TOO_LARGE";
  }
}

export async function readBoundedRequestBody(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await request.body?.cancel(); } catch { /* already closed */ }
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const cancelOnAbort = () => { reader.cancel().catch(() => {}); };
  request.signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) throw request.signal.reason || new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (request.signal.aborted) throw request.signal.reason || new DOMException("Aborted", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw error;
  } finally {
    request.signal.removeEventListener("abort", cancelOnAbort);
    try { reader.releaseLock(); } catch { /* reader already released */ }
  }
  return Buffer.concat(chunks, size);
}

export async function readBoundedFormData(request, maxBytes) {
  const body = await readBoundedRequestBody(request, maxBytes);
  const parsed = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
  return parsed.formData();
}
