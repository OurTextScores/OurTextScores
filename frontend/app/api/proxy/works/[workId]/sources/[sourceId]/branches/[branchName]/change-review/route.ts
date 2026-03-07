import { getApiAuthHeaders } from "../../../../../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../../../../../_lib/upstream";

export async function POST(
  request: Request,
  { params }: { params: { workId: string; sourceId: string; branchName: string } }
) {
  const API = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const body = await request.text();
  const res = await proxyFetch(
    request,
    `${API}/works/${encodeURIComponent(params.workId)}/sources/${encodeURIComponent(params.sourceId)}/branches/${encodeURIComponent(params.branchName)}/change-review`,
    {
      method: "POST",
      headers: {
        ...(auth.Authorization && { Authorization: auth.Authorization }),
        ...(body ? { "Content-Type": request.headers.get("content-type") || "application/json" } : {}),
      },
      body,
      cache: "no-store",
    },
  );
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/json",
    },
  });
}
