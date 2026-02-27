import { NextResponse, type NextRequest } from "next/server";

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

export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  const requestId = requestHeaders.get("x-request-id")?.trim() || crypto.randomUUID();
  const traceparent = ensureTraceparent(requestHeaders.get("traceparent"));
  const traceId = parseTraceIdFromTraceparent(traceparent);

  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("traceparent", traceparent);
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
  if (traceId) {
    response.headers.set("x-trace-id", traceId);
  }
  return response;
}

export const config = {
  matcher: ["/api/:path*"]
};
