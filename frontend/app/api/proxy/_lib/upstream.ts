export function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

const TRACE_HEADER_NAMES = [
  "x-upload-attempt-id",
  "x-request-id",
  "x-trace-id",
  "x-client-session-id",
  "x-session-id",
  "traceparent",
  "tracestate",
  "baggage"
] as const;

export function withTraceHeaders(request: Request, headers?: HeadersInit): Headers {
  const merged = new Headers(headers || {});
  for (const name of TRACE_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value && !merged.has(name)) {
      merged.set(name, value);
    }
  }
  return merged;
}

export function uploadResponseHeaders(response: Response): Headers {
  const headers = new Headers({ "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" });
  for (const name of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-upload-attempt-id"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function proxyFetch(
  request: Request,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return fetch(input, {
    ...(init || {}),
    headers: withTraceHeaders(request, init?.headers)
  });
}
