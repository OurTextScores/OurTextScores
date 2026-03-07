import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import BranchComments from "./branch-comments";
import BranchRating from "./branch-rating";
import CreateBranchClient from "./create-branch-client";
import OpenBranchReviewButton from "./open-branch-review-button";

export default async function BranchesPanel({
  workId,
  sourceId,
  latestRevisionId,
  currentUser,
}: {
  workId: string;
  sourceId: string;
  latestRevisionId?: string;
  currentUser?: { userId: string; email?: string; name?: string; roles?: string[] } | null;
}) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const authed = !!(headers && (headers as any).Authorization);
  const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/branches`, { headers, cache: 'no-store' });
  const data = res.ok ? await res.json() : { branches: [{ name: 'trunk', policy: 'public' }] };
  const branches: Array<{ name: string; policy: 'public' | 'owner_approval'; lifecycle?: 'open' | 'closed'; ownerUserId?: string }> = data.branches || [];
  const normalizedUser = currentUser ? { ...currentUser, isAdmin: Array.isArray(currentUser.roles) && currentUser.roles.includes('admin') } : null;

  return (
    <section className="rounded border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <h3 className="mb-3 font-semibold">Branches</h3>
      <div className="space-y-4">
        {branches.map((branch) => (
          <div key={branch.name} className="rounded border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/40">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-cyan-700 dark:text-cyan-300">{branch.name}</span>
                  <span className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-400">
                    {branch.policy === 'public' ? 'Reviewable branch' : 'Owner approval required'}
                  </span>
                  <span className={`rounded border px-2 py-0.5 text-xs ${branch.lifecycle === 'closed' ? 'border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300' : 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300'}`}>
                    {branch.lifecycle === 'closed' ? 'Closed for review' : 'Open'}
                  </span>
                </div>
                {branch.policy !== 'owner_approval' && authed && (
                  <OpenBranchReviewButton workId={workId} sourceId={sourceId} branchName={branch.name} />
                )}
                {branch.policy !== 'owner_approval' && !authed && (
                  <div className="text-xs text-slate-600 dark:text-slate-300">
                    <a href="/api/auth/signin" className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">Sign in</a> to open the shared change review.
                  </div>
                )}
              </div>
              <div className="w-full max-w-sm">
                <BranchRating
                  workId={workId}
                  sourceId={sourceId}
                  branchName={branch.name}
                  currentUser={normalizedUser}
                />
              </div>
            </div>
            <div className="mt-4">
              <BranchComments
                workId={workId}
                sourceId={sourceId}
                branchName={branch.name}
                currentUser={normalizedUser}
              />
            </div>
          </div>
        ))}
      </div>
      {authed ? (
        <div className="mt-4">
          <CreateBranchClient workId={workId} sourceId={sourceId} latestRevisionId={latestRevisionId} />
        </div>
      ) : (
        <div className="mt-4 text-xs text-slate-600 dark:text-slate-300">
          <a href="/api/auth/signin" className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"><span aria-hidden="true">↩ </span>Sign in</a> to create branches.
        </div>
      )}
    </section>
  );
}
