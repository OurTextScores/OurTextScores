import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import CreateBranchClient from "./create-branch-client";

export default async function BranchesPanel({ workId, sourceId, latestRevisionId }: { workId: string; sourceId: string; latestRevisionId?: string }) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const authed = !!(headers && (headers as any).Authorization);
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches`, { headers, cache: 'no-store' });
  const data = res.ok ? await res.json() : { branches: [{ name: 'main', policy: 'public' }] };
  const branches: Array<{ name: string; policy: 'public' | 'owner_approval'; ownerUserId?: string }> = data.branches || [];

  return (
    <section className="rounded border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <h3 className="mb-2 font-semibold">Branches</h3>
      <ul className="mb-3 space-y-2">
        {branches.map((b) => (
          <li key={b.name} className="flex items-center justify-between gap-3">
            <div>
              <span className="font-mono text-cyan-700 dark:text-cyan-300">{b.name}</span>
              <span className="ml-2 rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">
                {b.policy === 'public' ? 'Open' : 'Owner approval required'}
              </span>
            </div>
            {/* Branch policy is immutable; no update UI */}
          </li>
        ))}
      </ul>
      {authed ? (
        <CreateBranchClient workId={workId} sourceId={sourceId} latestRevisionId={latestRevisionId} />
      ) : (
        <div className="text-xs text-slate-600 dark:text-slate-300">
          <a href="/api/auth/signin" className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Sign in</a> to create branches.
        </div>
      )}
    </section>
  );
}
