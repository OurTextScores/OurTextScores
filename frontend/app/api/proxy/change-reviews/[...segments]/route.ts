import { getApiAuthHeaders } from "../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../_lib/upstream";

async function proxyToBackend(request: Request, segments: string[]) {
  const API = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
  const url = `${API}/change-reviews/${path}${new URL(request.url).search}`;
  const method = request.method;
  const headers = new Headers({
    ...(auth.Authorization && { Authorization: auth.Authorization }),
  });

  let body: string | undefined;
  if (!["GET", "HEAD"].includes(method)) {
    body = await request.text();
    if (body) {
      headers.set("Content-Type", request.headers.get("content-type") || "application/json");
    }
  }

  const res = await proxyFetch(request, url, {
    method,
    headers,
    body,
    cache: "no-store",
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/json",
    },
  });
}

export async function GET(request: Request, { params }: { params: { segments: string[] } }) {
  return proxyToBackend(request, params.segments || []);
}

export async function POST(request: Request, { params }: { params: { segments: string[] } }) {
  return proxyToBackend(request, params.segments || []);
}

export async function PATCH(request: Request, { params }: { params: { segments: string[] } }) {
  return proxyToBackend(request, params.segments || []);
}

export async function DELETE(request: Request, { params }: { params: { segments: string[] } }) {
  return proxyToBackend(request, params.segments || []);
}
