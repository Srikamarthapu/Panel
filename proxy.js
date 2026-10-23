import { NextResponse } from "next/server.js";
import { hasLoopbackRequestAuthority, isLocalApiRequestAllowed } from "./lib/local-request.js";

function apiRequestDenied() {
  return Response.json(
    { error: "Local API requests must come from Panel." },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        Vary: "Origin, Referer, Sec-Fetch-Site",
      },
    }
  );
}

export function proxy(request) {
  const pathname = new URL(request.url).pathname;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  if (!hasLoopbackRequestAuthority(request)) {
    if (isApi) return apiRequestDenied();
    return Response.json(
      { error: "Panel pages are only available from this Mac." },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (isApi && !isLocalApiRequestAllowed(request)) return apiRequestDenied();

  return NextResponse.next();
}

export const config = {
  matcher: "/:path*",
};
