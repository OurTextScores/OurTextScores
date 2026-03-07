import {
  buildScoreEditorOtsHeaders,
  proxyScoreEditorOtsJson
} from "../../../../../_lib/proxy";

export async function GET(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const { workId, sourceId } = params;
  return proxyScoreEditorOtsJson(
    request,
    `/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/history`,
    {
      headers: await buildScoreEditorOtsHeaders(request)
    }
  );
}
