import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "ots_session_id";
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseTraceIdFromTraceparent(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parts = value.trim().split("-");
  if (parts.length < 4) {
    return null;
  }
  const traceId = parts[1]?.toLowerCase();
  if (!traceId || !/^[0-9a-f]{32}$/.test(traceId)) {
    return null;
  }
  return traceId;
}

function ensureTraceparent(existing: string | null): string {
  if (existing && parseTraceIdFromTraceparent(existing)) {
    return existing;
  }
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return `00-${traceId}-${spanId}-01`;
}

function normalizeSessionId(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !SESSION_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const requestId = requestHeaders.get("x-request-id")?.trim() || crypto.randomUUID();
  const traceparent = ensureTraceparent(requestHeaders.get("traceparent"));
  const traceId = parseTraceIdFromTraceparent(traceparent);
  const sessionId =
    normalizeSessionId(requestHeaders.get("x-client-session-id")) ||
    normalizeSessionId(requestHeaders.get("x-session-id")) ||
    normalizeSessionId(request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null) ||
    crypto.randomUUID();

  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("traceparent", traceparent);
  requestHeaders.set("x-client-session-id", sessionId);
  requestHeaders.set("x-session-id", sessionId);
  if (traceId) {
    requestHeaders.set("x-trace-id", traceId);
  }

  const response = NextResponse.next({
    request: {
      headers: requestHeaders
    }
  });

  response.headers.set("x-request-id", requestId);
  response.headers.set("traceparent", traceparent);
  response.headers.set("x-client-session-id", sessionId);
  response.headers.set("x-session-id", sessionId);
  if (traceId) {
    response.headers.set("x-trace-id", traceId);
  }

  const traceSmokeRequested = requestHeaders.get("x-ots-trace-smoke") === "1";
  if (traceSmokeRequested && request.nextUrl.pathname.startsWith("/api/score-editor/")) {
    console.info(JSON.stringify({
      event: "frontend.score_editor_proxy.trace",
      route: request.nextUrl.pathname,
      method: request.method,
      requestId,
      traceId: traceId || null,
      sessionId,
    }));
  }

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: sessionId,
    path: "/",
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

export const config = {
  matcher: ["/api/:path*"]
};
