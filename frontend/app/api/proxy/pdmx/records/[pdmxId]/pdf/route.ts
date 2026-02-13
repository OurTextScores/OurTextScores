import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../../lib/authToken";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export async function GET(
  _request: Request,
  { params }: { params: { pdmxId: string } }
) {
  const API = getBackendApiBase();
  const { pdmxId } = params;
  try {
    const auth = await getApiAuthHeaders();
    const headers = new Headers();
    if (auth.Authorization) headers.set("authorization", auth.Authorization);

    const upstream = await fetch(
      `${API}/pdmx/records/${encodeURIComponent(pdmxId)}/pdf`,
      {
        method: "GET",
        headers,
        cache: "no-store"
      }
    );

    const buf = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "application/pdf";
    const contentDisposition = upstream.headers.get("content-disposition") || undefined;

    return new NextResponse(buf, {
      status: upstream.status,
      headers: {
        "content-type": contentType,
        ...(contentDisposition ? { "content-disposition": contentDisposition } : {})
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
