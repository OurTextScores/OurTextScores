import { getApiAuthHeaders } from "../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../_lib/upstream";

async function proxyScanner(request: Request, segments: string[]) {
  const auth = await getApiAuthHeaders();
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const url = `${getBackendApiBase()}/scanner/${path}${new URL(request.url).search}`;
  const headers = new Headers();
  if (auth.Authorization) headers.set("Authorization", auth.Authorization);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const accepts = request.headers.get("accept");
  if (accepts) headers.set("Accept", accepts);

  const hasBody = !["GET", "HEAD"].includes(request.method);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    cache: "no-store",
    ...(hasBody ? { body: request.body, duplex: "half" } : {}),
  };
  const upstream = await proxyFetch(request, url, init);
  const responseHeaders = new Headers();
  for (const name of [
    "content-type",
    "content-disposition",
    "cache-control",
    "x-content-type-options",
    "location",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Belt and braces: artifacts are unreviewed provider output, so refuse
  // sniffing even if the backend header were ever dropped upstream.
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

type Context = { params: { segments: string[] } };

export function GET(request: Request, context: Context) {
  return proxyScanner(request, context.params.segments || []);
}

export function POST(request: Request, context: Context) {
  return proxyScanner(request, context.params.segments || []);
}

export function PATCH(request: Request, context: Context) {
  return proxyScanner(request, context.params.segments || []);
}

export function DELETE(request: Request, context: Context) {
  return proxyScanner(request, context.params.segments || []);
}
