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

// App token headers the editor API accepts. We always set these from server
// env and strip any client-supplied copies so callers can't spoof the token.
const APP_TOKEN_HEADERS = ["x-ots-api-token", "x-music-api-token"];

function applyEditorApiToken(headers: Headers): void {
  APP_TOKEN_HEADERS.forEach((header) => headers.delete(header));
  const token = process.env.SCORE_EDITOR_API_TOKEN?.trim();
  if (token) {
    headers.set("x-ots-api-token", token);
  }
}

function buildUpstreamUrl(request: Request, segments: string[]): string {
  const origin = process.env.SCORE_EDITOR_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin) {
    throw new Error("SCORE_EDITOR_API_ORIGIN is not configured.");
  }

  const upstream = new URL(`${origin}/api/music/${segments.map(encodeURIComponent).join("/")}`);
  upstream.search = new URL(request.url).search;
  return upstream.toString();
}

async function proxyMusicRequest(
  request: Request,
  { params }: { params: { segments: string[] } }
): Promise<Response> {
  const headers = new Headers(request.headers);
  HOP_BY_HOP_HEADERS.forEach((header) => headers.delete(header));
  applyEditorApiToken(headers);

  const method = request.method.toUpperCase();
  const upstream = await fetch(buildUpstreamUrl(request, params.segments), {
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
}

export const GET = proxyMusicRequest;
export const POST = proxyMusicRequest;
export const PUT = proxyMusicRequest;
export const PATCH = proxyMusicRequest;
export const DELETE = proxyMusicRequest;
