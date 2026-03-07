import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";

interface ChangeReviewDetail {
  reviewId: string;
  workId: string;
  sourceId: string;
  branchName?: string;
  baseRevisionId: string;
  headRevisionId: string;
  baseSequenceNumber: number;
  headSequenceNumber: number;
  reviewerUserId: string;
  reviewerUsername?: string;
  ownerUserId: string;
  ownerUsername?: string;
  title?: string;
  summary?: string;
  status: "draft" | "open" | "closed" | "withdrawn";
  unresolvedThreadCount: number;
  openThreadCount: number;
  resolvedThreadCount: number;
  lastActivityAt: string;
  createdAt: string;
  submittedAt?: string;
  work: {
    workId: string;
    title?: string;
    composer?: string;
  };
  source: {
    sourceId: string;
    label?: string;
    sourceType?: string;
  };
}

interface ReviewDiffResponse {
  reviewId: string;
  fileKind: "canonical";
  baseRevisionId: string;
  headRevisionId: string;
  hunks: Array<{
    hunkId: string;
    header: string;
    lines: Array<{
      anchorId: string;
      type: "context" | "add" | "del";
      oldLineNumber?: number;
      newLineNumber?: number;
      content: string;
      commentable: boolean;
      lineHash: string;
      hunkHeader: string;
    }>;
  }>;
  threads: Array<{
    threadId: string;
    status: "open" | "resolved";
    diffAnchor: {
      anchorId: string;
      lineText: string;
    };
    comments: Array<{
      commentId: string;
      userId: string;
      username?: string;
      content: string;
      createdAt: string;
      editedAt?: string;
    }>;
  }>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers = await getApiAuthHeaders();
  const res = await fetch(url, { headers, cache: "no-store" });
  if (res.status === 401) redirect("/api/auth/signin");
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`Failed to load ${url}`);
  return res.json();
}

export default async function ChangeReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = await params;
  const API_BASE = getApiBase();
  const [review, diff] = await Promise.all([
    fetchJson<ChangeReviewDetail>(`${API_BASE}/change-reviews/${encodeURIComponent(reviewId)}`),
    fetchJson<ReviewDiffResponse>(`${API_BASE}/change-reviews/${encodeURIComponent(reviewId)}/diff`),
  ]);

  const threadsByAnchor = new Map(diff.threads.map((thread) => [thread.diffAnchor.anchorId, thread]));

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto w-full max-w-7xl px-6">
        <header className="mb-8 flex items-start justify-between gap-6">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold">{review.title || "Change Review"}</h1>
              <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {review.status}
              </span>
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {review.work.title || review.work.workId}
              {review.work.composer ? ` · ${review.work.composer}` : ""}
              {" · "}
              {review.source.label || review.source.sourceId}
              {review.branchName ? ` · ${review.branchName}` : ""}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-500">
              Diff #{review.baseSequenceNumber} → #{review.headSequenceNumber}
              {" · "}
              Reviewer: {review.reviewerUsername || review.reviewerUserId}
              {" · "}
              Owner: {review.ownerUsername || review.ownerUserId}
            </div>
            {review.summary ? (
              <p className="mt-3 max-w-3xl text-sm text-slate-700 dark:text-slate-300">{review.summary}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <Link href="/change-reviews" className="text-sm text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">
              Back to change reviews
            </Link>
            <Link href={`/works/${encodeURIComponent(review.workId)}`} className="text-sm text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">
              Open work
            </Link>
          </div>
        </header>

        <section className="mb-6 grid gap-3 md:grid-cols-4">
          <div className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Unresolved</div>
            <div className="mt-1 text-2xl font-semibold">{review.unresolvedThreadCount}</div>
          </div>
          <div className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Open Threads</div>
            <div className="mt-1 text-2xl font-semibold">{review.openThreadCount}</div>
          </div>
          <div className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Resolved Threads</div>
            <div className="mt-1 text-2xl font-semibold">{review.resolvedThreadCount}</div>
          </div>
          <div className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Last Activity</div>
            <div className="mt-1 text-sm font-medium">{new Date(review.lastActivityAt).toLocaleString()}</div>
          </div>
        </section>

        <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Canonical XML Diff</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {diff.threads.length} thread{diff.threads.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-6">
            {diff.hunks.map((hunk) => (
              <div key={hunk.hunkId} className="overflow-hidden rounded border border-slate-200 dark:border-slate-800">
                <div className="bg-slate-100 px-3 py-2 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {hunk.header}
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {hunk.lines.map((line) => {
                    const thread = threadsByAnchor.get(line.anchorId);
                    const lineClasses =
                      line.type === "add"
                        ? "bg-emerald-50 dark:bg-emerald-950/20"
                        : line.type === "del"
                          ? "bg-rose-50 dark:bg-rose-950/20"
                          : "bg-white dark:bg-slate-950/40";
                    return (
                      <div key={line.anchorId} className={lineClasses}>
                        <div className="grid grid-cols-[5rem_5rem_1fr] gap-3 px-3 py-2 font-mono text-xs">
                          <span className="text-slate-400">{line.oldLineNumber ?? ""}</span>
                          <span className="text-slate-400">{line.newLineNumber ?? ""}</span>
                          <code className="whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
                            <span className="mr-2 text-slate-400">
                              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                            </span>
                            {line.content}
                          </code>
                        </div>
                        {thread ? (
                          <div className="border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
                            <div className="mb-2 flex items-center gap-2">
                              <span className="font-medium text-slate-800 dark:text-slate-100">Thread</span>
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                {thread.status}
                              </span>
                            </div>
                            <div className="space-y-2">
                              {thread.comments.map((comment) => (
                                <div key={comment.commentId} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60">
                                  <div className="text-xs text-slate-500 dark:text-slate-400">
                                    {comment.username || comment.userId} · {new Date(comment.createdAt).toLocaleString()}
                                  </div>
                                  <div className="mt-1 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200">
                                    {comment.content}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
