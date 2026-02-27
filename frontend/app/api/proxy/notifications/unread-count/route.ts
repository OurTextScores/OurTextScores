import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../_lib/upstream";

export async function GET(request: Request) {
  const API = getBackendApiBase();

  try {
    const auth = await getApiAuthHeaders();

    const res = await proxyFetch(request, 
      `${API}/notifications/unread-count`,
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
