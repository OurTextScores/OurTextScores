import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../proxy/_lib/upstream";

export function buildScoreEditorOtsUpstreamUrl(request: Request, path: string): string {
  const backend = getBackendApiBase();
  const upstream = new URL(`${backend}${path}`);
  const incoming = new URL(request.url);
  upstream.search = incoming.search;
  return upstream.toString();
}

export async function buildScoreEditorOtsHeaders(
  request: Request,
  options?: {
    includeContentType?: boolean;
    includeProgressHeader?: boolean;
    headers?: HeadersInit;
  }
): Promise<Headers> {
  const auth = await getApiAuthHeaders();
  const headers = new Headers(options?.headers || {});

  if (options?.includeContentType) {
    const contentType = request.headers.get("content-type");
    if (contentType) {
      headers.set("content-type", contentType);
    }
  }

  if (options?.includeProgressHeader) {
    const progressId = request.headers.get("x-progress-id");
    if (progressId) {
      headers.set("x-progress-id", progressId);
    }
  }

  if (auth.Authorization && !headers.has("authorization")) {
    headers.set("authorization", auth.Authorization);
  }

  return headers;
}

export async function proxyScoreEditorOtsJson(
  request: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const upstream = await proxyFetch(request, buildScoreEditorOtsUpstreamUrl(request, path), {
    ...(init || {}),
    cache: "no-store",
  });

  const responseText = await upstream.text();
  let payload: unknown = responseText;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = responseText;
  }

  return NextResponse.json(payload, { status: upstream.status });
}

export async function proxyScoreEditorOtsPassthrough(
  request: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const upstream = await proxyFetch(request, buildScoreEditorOtsUpstreamUrl(request, path), {
    ...(init || {}),
    cache: "no-store",
  });
  const buffer = await upstream.arrayBuffer();

  return new NextResponse(buffer, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json"
    }
  });
}
