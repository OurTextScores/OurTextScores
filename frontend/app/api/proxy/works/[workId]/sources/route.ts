import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../lib/authToken";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export async function POST(request: Request, { params }: { params: { workId: string } }) {
  const API = getBackendApiBase();
  const { workId } = params;
  try {
    const auth = await getApiAuthHeaders();
    const headers = new Headers();
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const progress = request.headers.get("x-progress-id");
    if (progress) headers.set("x-progress-id", progress);
    if (auth.Authorization) headers.set("authorization", auth.Authorization);

    const init: any = {
      method: "POST",
      headers,
      body: request.body as any,
      cache: "no-store",
      duplex: 'half'
    };
    const upstream = await fetch(`${API}/works/${encodeURIComponent(workId)}/sources`, init as any);
    const buf = await upstream.arrayBuffer();
    return new NextResponse(buf, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json" } });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
