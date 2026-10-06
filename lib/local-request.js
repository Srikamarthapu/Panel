const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
}

function parseLocalUrl(value, base) {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!isLoopbackHostname(url.hostname)) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function parseOrigin(value) {
  if (typeof value !== "string" || !value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function sameLocalAuthority(left, right) {
  return Boolean(
    left &&
      right &&
      left.protocol === right.protocol &&
      left.port === right.port &&
      isLoopbackHostname(left.hostname) &&
      isLoopbackHostname(right.hostname)
  );
}

function trustedTauriOrigin(value) {
  const parsed = parseOrigin(value);
  return Boolean(parsed && isTauriUrl(parsed));
}

function trustedTauriReferer(value) {
  try {
    const url = new URL(value);
    return Boolean(!url.username && !url.password && isTauriUrl(url));
  } catch {
    return false;
  }
}

function isTauriUrl(url) {
  return Boolean(
    url &&
      !url.username &&
      !url.password &&
      !url.port &&
      ((url.protocol === "tauri:" && url.hostname === "localhost") ||
        (url.protocol === "http:" && url.hostname === "tauri.localhost"))
  );
}

/**
 * Restrict browser access to the loopback dashboard and its packaged Tauri
 * origin. This is a browser CSRF/DNS-rebinding boundary, not authentication:
 * non-browser local clients can still connect and must be treated as trusted.
 */
export function isLocalApiRequestAllowed(request) {
  if (!request?.headers || typeof request.url !== "string") return false;

  const requestUrl = parseLocalUrl(request.url);
  const hostHeader = request.headers.get("host");
  const hostUrl = hostHeader ? parseLocalUrl(`${requestUrl?.protocol || "http:"}//${hostHeader}`) : null;
  if (!sameLocalAuthority(requestUrl, hostUrl)) return false;

  const origin = request.headers.get("origin");
  const originIsTauri = Boolean(origin && trustedTauriOrigin(origin));
  let originIsLocal = false;

  if (origin) {
    const originUrl = parseOrigin(origin);
    if (originIsTauri) {
      // Tauri's macOS webview uses tauri://localhost; its backend is still a
      // loopback HTTP server. The Windows alias is fixed and accepted for
      // future portability, while public web origins remain denied.
    } else {
      const localOriginUrl = originUrl && parseLocalUrl(originUrl.origin);
      if (!sameLocalAuthority(localOriginUrl, requestUrl)) return false;
      originIsLocal = true;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && !originIsLocal && !originIsTauri) return false;

  const referer = request.headers.get("referer");
  if (referer) {
    if (trustedTauriReferer(referer)) return true;
    const refererUrl = parseLocalUrl(referer);
    if (!sameLocalAuthority(refererUrl, requestUrl)) return false;
  }

  return true;
}
