import { NextResponse } from "next/server";
import {
  buildScoreEditorOtsHeaders,
  proxyScoreEditorOtsJson
} from "../../../../../_lib/proxy";

export async function GET(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const { workId, sourceId } = params;
  const headers = await buildScoreEditorOtsHeaders(request);
  return proxyScoreEditorOtsJson(
    request,
    `/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches`,
    { headers }
  );
}

export async function POST(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const { workId, sourceId } = params;

  try {
    const body = await request.json();
    const headers = await buildScoreEditorOtsHeaders(request, {
      includeContentType: true,
      headers: { "content-type": "application/json" }
    });

    return proxyScoreEditorOtsJson(
      request,
      `/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }
    );
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
