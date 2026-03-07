import { NextResponse } from "next/server";
import { getBackendApiBase, proxyFetch } from "../../../../../../../_lib/upstream";

export async function GET(
  request: Request,
  { params }: { params: { workId: string; sourceId: string; branchName: string } }
) {
  const API = getBackendApiBase();
  const { workId, sourceId, branchName } = params;

  try {
    const res = await proxyFetch(
      request,
      `${API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches/${encodeURIComponent(branchName)}/ratings`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store"
      }
    );

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
