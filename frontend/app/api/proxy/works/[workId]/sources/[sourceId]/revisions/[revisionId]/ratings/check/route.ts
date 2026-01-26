import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../../../../../../lib/authToken";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export async function GET(
  request: Request,
  { params }: { params: { workId: string; sourceId: string; revisionId: string } }
) {
  const API = getBackendApiBase();
  const { workId, sourceId, revisionId } = params;

  try {
    const auth = await getApiAuthHeaders();

    const res = await fetch(
      `${API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions/${encodeURIComponent(revisionId)}/ratings/check`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(auth.Authorization && { Authorization: auth.Authorization })
        },
        cache: "no-store"
      }
    );

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
