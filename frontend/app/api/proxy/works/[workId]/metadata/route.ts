import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../_lib/upstream";

export async function POST(
  request: Request,
  { params }: { params: { workId: string } }
) {
  const API = getBackendApiBase();
  const { workId } = params;

  try {
    const auth = await getApiAuthHeaders();
    const body = await request.json();

    const upstream = await proxyFetch(request, 
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
