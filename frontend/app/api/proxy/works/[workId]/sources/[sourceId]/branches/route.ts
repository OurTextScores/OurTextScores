import { getApiAuthHeaders } from "../../../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../../../_lib/upstream";

export async function GET(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const API = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const res = await proxyFetch(
    request,
    `${API}/works/${encodeURIComponent(params.workId)}/sources/${encodeURIComponent(params.sourceId)}/branches`,
    {
      method: "GET",
      headers: {
        ...(auth.Authorization && { Authorization: auth.Authorization }),
      },
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
