import {
  buildScoreEditorOtsHeaders,
  proxyScoreEditorOtsPassthrough
} from "../../../../../_lib/proxy";

export async function GET(
  request: Request,
  { params }: { params: { workId: string; sourceId: string } }
) {
  const { workId, sourceId } = params;
  const headers = await buildScoreEditorOtsHeaders(request);
  return proxyScoreEditorOtsPassthrough(
    request,
    `/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml`,
    { headers }
  );
}
