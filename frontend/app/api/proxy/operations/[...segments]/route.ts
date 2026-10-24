import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../_lib/upstream";

async function forward(
  request: Request,
  segments: string[],
  method: "GET" | "POST",
) {
  const path = segments.join("/");
  const allowed =
    method === "GET"
      ? ["uploads", "upload-limits"]
      : ["upload-limits", "upload-limit-lookup", "upload-observations"];
  if (!allowed.includes(path))
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const auth = await getApiAuthHeaders();
  if (!auth.Authorization)
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  const query = new URL(request.url).search;
  const response = await proxyFetch(
    request,
    `${getBackendApiBase()}/operations/${path}${query}`,
    {
      method,
      headers: { ...auth, "content-type": "application/json" },
      body: method === "POST" ? await request.text() : undefined,
      cache: "no-store",
    },
  );
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
export function GET(
  request: Request,
  { params }: { params: { segments: string[] } },
) {
  return forward(request, params.segments, "GET");
}
export function POST(
  request: Request,
  { params }: { params: { segments: string[] } },
) {
  return forward(request, params.segments, "POST");
}
