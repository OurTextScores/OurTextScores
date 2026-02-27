import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../../_lib/upstream";

export async function POST(
  request: Request,
  { params }: { params: { workId: string } }
) {
  const API = getBackendApiBase();
  const { workId } = params;

  try {
    const auth = await getApiAuthHeaders();
    const upstream = await proxyFetch(request, 
      `${API}/imslp/works/${encodeURIComponent(workId)}/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": request.headers.get("content-type") || "application/json",
          ...(auth.Authorization ? { Authorization: auth.Authorization } : {})
        },
        cache: "no-store"
      }
    );

    const responseText = await upstream.text();
    let responseData: unknown = responseText;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      // non-JSON response
    }

    return NextResponse.json(responseData, { status: upstream.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
