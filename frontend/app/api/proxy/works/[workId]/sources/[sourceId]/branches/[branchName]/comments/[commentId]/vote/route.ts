import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../../../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../../../../../../../_lib/upstream";

export async function POST(
  request: Request,
  { params }: { params: { workId: string; sourceId: string; branchName: string; commentId: string } }
) {
  const API = getBackendApiBase();
  const { workId, sourceId, branchName, commentId } = params;

  try {
    const auth = await getApiAuthHeaders();
    const body = await request.json();
    const res = await proxyFetch(
      request,
      `${API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches/${encodeURIComponent(branchName)}/comments/${encodeURIComponent(commentId)}/vote`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth.Authorization && { Authorization: auth.Authorization })
        },
        body: JSON.stringify(body),
        cache: "no-store"
      }
    );

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
