import { NextResponse } from "next/server";
import { isLocalApiRequestAllowed } from "./lib/local-request.js";

export function proxy(request) {
  if (!isLocalApiRequestAllowed(request)) {
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

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
