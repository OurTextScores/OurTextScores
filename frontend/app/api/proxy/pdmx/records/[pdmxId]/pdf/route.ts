import { NextResponse } from "next/server";
import { getApiAuthHeaders } from "../../../../../../lib/authToken";
import { getBackendApiBase, proxyFetch } from "../../../../_lib/upstream";

export async function GET(
  request: Request,
  { params }: { params: { pdmxId: string } }
) {
  const API = getBackendApiBase();
  const { pdmxId } = params;
  try {
    const auth = await getApiAuthHeaders();
    const headers = new Headers();
    if (auth.Authorization) headers.set("authorization", auth.Authorization);

    const upstream = await proxyFetch(request, 
      `${API}/pdmx/records/${encodeURIComponent(pdmxId)}/pdf`,
      {
        method: "GET",
        headers,
        cache: "no-store"
      }
    );

    const buf = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "application/pdf";
    const contentDisposition = upstream.headers.get("content-disposition") || undefined;

    return new NextResponse(buf, {
      status: upstream.status,
      headers: {
        "content-type": contentType,
        ...(contentDisposition ? { "content-disposition": contentDisposition } : {})
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
