// Shared proxy for the OTS_Web editor API (music + llm routes). Forwards to
// SCORE_EDITOR_API_ORIGIN and injects the app auth token so the editor API's
// server-credential / LLM routes accept the request. Centralizing the token
// logic keeps the (security-critical) header handling in one place.

const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

// Token headers the editor API accepts. Always set from server env and strip any
// client-supplied copies so callers can't spoof the token.
const APP_TOKEN_HEADERS = ["x-ots-api-token", "x-music-api-token"];

export function applyEditorApiToken(headers: Headers): void {
  APP_TOKEN_HEADERS.forEach((header) => headers.delete(header));
  const token = process.env.SCORE_EDITOR_API_TOKEN?.trim();
  if (token) {
    headers.set("x-ots-api-token", token);
  }
}

export function buildEditorApiUpstreamUrl(
  request: Request,
  segments: string[],
  prefix: string
): string {
  const origin = process.env.SCORE_EDITOR_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin) {
    throw new Error("SCORE_EDITOR_API_ORIGIN is not configured.");
  }

  const upstream = new URL(`${origin}/api/${prefix}/${segments.map(encodeURIComponent).join("/")}`);
  upstream.search = new URL(request.url).search;
  return upstream.toString();
}

type RouteContext = {
  params: { segments: string[] } | Promise<{ segments: string[] }>;
};

// Returns a route handler that proxies /api/score-editor/<prefix>/* to the
// editor API's /api/<prefix>/* with the app token injected.
export function createEditorApiProxy(prefix: string) {
  return async function proxy(request: Request, context: RouteContext): Promise<Response> {
    const { segments } = await context.params;

    const headers = new Headers(request.headers);
    HOP_BY_HOP_HEADERS.forEach((header) => headers.delete(header));
    applyEditorApiToken(headers);

    const method = request.method.toUpperCase();
    const upstream = await fetch(buildEditorApiUpstreamUrl(request, segments, prefix), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      redirect: "manual"
    });

    const responseHeaders = new Headers(upstream.headers);
    HOP_BY_HOP_HEADERS.forEach((header) => responseHeaders.delete(header));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  };
}
