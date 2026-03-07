import { NextResponse } from "next/server";
import {
  buildScoreEditorOtsHeaders,
  proxyScoreEditorOtsPassthrough
} from "../../../../../_lib/proxy";

export async function POST(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const { workId, sourceId } = params;

  try {
    const headers = await buildScoreEditorOtsHeaders(request, {
      includeContentType: true,
      includeProgressHeader: true
    });
    const init: any = {
      method: "POST",
      headers,
      body: request.body as BodyInit,
      duplex: "half"
    };

    return proxyScoreEditorOtsPassthrough(
      request,
      `/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions`,
      init
    );
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
