import Link from "next/link";
import { redirect } from "next/navigation";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";

interface ChangeReviewListItem {
  reviewId: string;
  workId: string;
  sourceId: string;
  branchName?: string;
  baseSequenceNumber: number;
  headSequenceNumber: number;
  reviewerUserId: string;
  reviewerUsername?: string;
  ownerUserId: string;
  ownerUsername?: string;
  title?: string;
  status: "draft" | "open" | "closed" | "withdrawn";
  unresolvedThreadCount: number;
  submittedAt?: string;
  lastActivityAt: string;
  workTitle?: string;
  composer?: string;
  sourceLabel?: string;
  sourceType?: string;
}

async function fetchSection(
  role: "reviewer" | "owner",
  status: "draft" | "open",
): Promise<ChangeReviewListItem[]> {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/change-reviews?role=${encodeURIComponent(role)}&status=${encodeURIComponent(status)}`, {
    headers,
    cache: "no-store",
  });
  if (res.status === 401) {
    redirect("/api/auth/signin");
  }
  if (!res.ok) {
    throw new Error(`Failed to load change reviews (${role}/${status})`);
  }
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

function ReviewSection({
  title,
  emptyText,
  items,
}: {
  title: string;
  emptyText: string;
  items: ChangeReviewListItem[];
}) {
  return (
    <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{emptyText}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.reviewId} className="rounded border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950/60">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/change-reviews/${encodeURIComponent(item.reviewId)}`}
                      className="font-semibold text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                    >
                      {item.title || `${item.workTitle || item.workId} · ${item.sourceLabel || item.sourceId}`}
                    </Link>
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {item.status}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {item.workTitle || item.workId}
                    {item.composer ? ` · ${item.composer}` : ""}
                    {" · "}
                    {item.sourceLabel || item.sourceId}
                    {item.branchName ? ` · ${item.branchName}` : ""}
                  </div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-500">
                    Diff #{item.baseSequenceNumber} → #{item.headSequenceNumber}
                    {" · "}
                    Reviewer: {item.reviewerUsername || item.reviewerUserId}
                    {" · "}
                    Owner: {item.ownerUsername || item.ownerUserId}
                  </div>
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-500">
                    {item.unresolvedThreadCount} unresolved thread{item.unresolvedThreadCount === 1 ? "" : "s"}
                    {" · "}
                    Last activity {new Date(item.lastActivityAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Link
                    href={`/change-reviews/${encodeURIComponent(item.reviewId)}`}
                    className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300"
                  >
                    Open Review
                  </Link>
                  <Link
                    href={`/works/${encodeURIComponent(item.workId)}`}
                    className="text-xs text-slate-600 underline-offset-2 hover:underline dark:text-slate-400"
                  >
                    Open Work
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function ChangeReviewsPage() {
  const [needsResponse, drafts, openByYou] = await Promise.all([
    fetchSection("owner", "open"),
    fetchSection("reviewer", "draft"),
    fetchSection("reviewer", "open"),
  ]);

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto w-full max-w-6xl px-6">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold">Change Reviews</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Review drafts, open reviews awaiting your response, and reviews you have submitted.
            </p>
          </div>
          <Link href="/" className="text-sm text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">
            Back to works
          </Link>
        </header>

        <div className="space-y-6">
          <ReviewSection
            title="Needs Your Response"
            emptyText="No open change reviews currently need your response."
            items={needsResponse}
          />
          <ReviewSection
            title="Drafts"
            emptyText="You have no draft change reviews."
            items={drafts}
          />
          <ReviewSection
            title="Open By You"
            emptyText="You have no submitted open change reviews."
            items={openByYou}
          />
        </div>
      </div>
    </main>
  );
}
