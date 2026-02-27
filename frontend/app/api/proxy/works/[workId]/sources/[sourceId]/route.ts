import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../../_lib/upstream";

export async function PATCH(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const API = getBackendApiBase();
  const { workId, sourceId } = params;
  try {
    const auth = await getApiAuthHeaders();
    const body = await request.json();

    const upstream = await proxyFetch(request, 
      `${API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(auth.Authorization ? { Authorization: auth.Authorization } : {}),
        },
        body: JSON.stringify(body),
        cache: "no-store",
      }
    );

    const responseText = await upstream.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    return NextResponse.json(responseData, { status: upstream.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: String(err?.message || err) },
      { status: 500 }
    );
  }
}
