import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../lib/authToken";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export async function POST(
  request: Request,
  { params }: { params: { workId: string } }
) {
  const API = getBackendApiBase();
  const { workId } = params;

  try {
    const auth = await getApiAuthHeaders();
    const body = await request.json();

    const upstream = await fetch(
      `${API}/works/${encodeURIComponent(workId)}/metadata`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth.Authorization ? { Authorization: auth.Authorization } : {})
        },
        body: JSON.stringify(body),
        cache: "no-store"
      }
    );

    const responseText = await upstream.text();
    let responseData: unknown = responseText;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      // non-JSON response, keep raw text
    }

    return NextResponse.json(responseData, { status: upstream.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
