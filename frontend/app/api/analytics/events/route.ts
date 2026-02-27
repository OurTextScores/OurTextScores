import { NextResponse } from "next/server";
import { getBackendApiBase, proxyFetch } from "../../proxy/_lib/upstream";

const API = getBackendApiBase();

export async function POST(request: Request) {
  try {
    const body = await request.text();
    const upstream = await proxyFetch(request, `${API}/analytics/events`, {
      method: "POST",
      headers: {
        "content-type": request.headers.get("content-type") || "application/json",
      },
      body,
    });

    const payload = await upstream.text();
    return new NextResponse(payload, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Failed to proxy analytics events",
      },
      { status: 500 },
    );
  }
}
