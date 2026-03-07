import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import ChangeReviewDetailClient from "../change-review-detail-client";

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
  permissions: {
    canRead: boolean;
    canEditDraft: boolean;
    canAddThread: boolean;
    canSubmit: boolean;
    canClose: boolean;
    canWithdraw: boolean;
    canReply: boolean;
    canResolve: boolean;
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

        <ChangeReviewDetailClient initialReview={review} initialDiff={diff} />
      </div>
    </main>
  );
}
