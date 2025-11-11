import Link from "next/link";
import { redirect } from "next/navigation";
import { getApiBase, getPublicApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";
import { approveRevisionAction, rejectRevisionAction } from "./actions";

export default async function ApprovalsPage() {
  const API_BASE = getApiBase();
  const PUBLIC_API_BASE = getPublicApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/approvals/inbox`, { headers, cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 401) redirect('/api/auth/signin');
    const body = await res.text();
    throw new Error(body || 'Failed to load approvals');
  }
  const data = await res.json();
  const items: Array<{
    workId: string;
    sourceId: string;
    revisionId: string;
    sequenceNumber: number;
    createdAt: string;
    createdBy: string;
    changeSummary?: string;
  }> = data.items || [];

  // Fetch work details (grouped by workId) to compute previous revision ids
  const grouped = new Map<string, typeof items>();
  for (const it of items) {
    const list = grouped.get(it.workId) || [] as any;
    (list as any).push(it);
    grouped.set(it.workId, list as any);
  }
  const workDetails = new Map<string, any>();
  for (const [workId] of grouped) {
    const wr = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}`, { headers, cache: 'no-store' });
    if (wr.ok) workDetails.set(workId, await wr.json());
  }

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto w-full max-w-5xl px-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Approvals Inbox</h1>
          <Link href="/" className="text-sm text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Back to works</Link>
        </header>

        {items.length === 0 ? (
          <p className="rounded border border-slate-200 bg-white p-6 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">No pending approvals.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => {
              const wd = workDetails.get(item.workId);
              const source = wd?.sources?.find((s: any) => s.sourceId === item.sourceId);
              const pendingIdx = source ? source.revisions.findIndex((r: any) => r.revisionId === item.revisionId) : -1;
              const prev = pendingIdx >= 0 && source.revisions[pendingIdx + 1] ? source.revisions[pendingIdx + 1].revisionId : undefined;
              const textdiffLinearized = prev ? `${PUBLIC_API_BASE}/works/${encodeURIComponent(item.workId)}/sources/${encodeURIComponent(item.sourceId)}/textdiff?revA=${encodeURIComponent(prev)}&revB=${encodeURIComponent(item.revisionId)}&file=linearized` : undefined;
              const musicdiff = prev ? `${PUBLIC_API_BASE}/works/${encodeURIComponent(item.workId)}/sources/${encodeURIComponent(item.sourceId)}/musicdiff?revA=${encodeURIComponent(prev)}&revB=${encodeURIComponent(item.revisionId)}` : undefined;
              const mxl = `${PUBLIC_API_BASE}/works/${encodeURIComponent(item.workId)}/sources/${encodeURIComponent(item.sourceId)}/normalized.mxl?r=${encodeURIComponent(item.revisionId)}`;
              const xml = `${PUBLIC_API_BASE}/works/${encodeURIComponent(item.workId)}/sources/${encodeURIComponent(item.sourceId)}/canonical.xml?r=${encodeURIComponent(item.revisionId)}`;
              return (
                <li key={item.revisionId} className="rounded border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900/60">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-mono text-cyan-700 dark:text-cyan-300">{item.workId}/{item.sourceId} • {item.revisionId}</div>
                      <div className="text-slate-600 dark:text-slate-400">Sequence #{item.sequenceNumber} • {new Date(item.createdAt).toLocaleString()}</div>
                      {item.changeSummary && <div className="mt-1 text-slate-800 dark:text-slate-200">{item.changeSummary}</div>}
                      <div className="mt-2 flex flex-wrap gap-3 text-xs">
                        <a href={mxl} className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300" target="_blank">MXL</a>
                        <a href={xml} className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300" target="_blank">XML</a>
                        {textdiffLinearized && <a href={textdiffLinearized} className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300" target="_blank">Text diff (LMX)</a>}
                        {musicdiff && <a href={musicdiff} className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300" target="_blank">Musicdiff</a>}
                        <Link href={`/works/${encodeURIComponent(item.workId)}`} className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Open work</Link>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <form action={async () => { 'use server'; await approveRevisionAction(item.workId, item.sourceId, item.revisionId); }}>
                        <button type="submit" className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700">Approve</button>
                      </form>
                      <form action={async () => { 'use server'; await rejectRevisionAction(item.workId, item.sourceId, item.revisionId); }}>
                        <button type="submit" className="rounded bg-rose-600 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-700">Reject</button>
                      </form>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
