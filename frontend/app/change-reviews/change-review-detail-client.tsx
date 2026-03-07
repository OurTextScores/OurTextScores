"use client";

import { useEffect, useState, useTransition } from "react";

type ReviewDetail = {
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
  work: { workId: string; title?: string; composer?: string };
  source: { sourceId: string; label?: string; sourceType?: string };
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
};

type ReviewDiff = {
  reviewId: string;
  fileKind: "canonical";
  baseRevisionId: string;
  headRevisionId: string;
  scoreRegions: Array<{
    anchorId: string;
    partId: string;
    partIndex: number;
    partName?: string;
    side: "base" | "head";
    changeType: "added" | "removed" | "modified";
    baseMeasureIndex?: number;
    headMeasureIndex?: number;
    baseMeasureNumber?: string;
    headMeasureNumber?: string;
    label: string;
    summary: string;
    commentable: boolean;
    regionHash: string;
  }>;
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
    diffAnchor: { anchorId: string; lineText: string };
    comments: Array<{
      commentId: string;
      userId: string;
      username?: string;
      content: string;
      createdAt: string;
      editedAt?: string;
    }>;
  }>;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function ChangeReviewDetailClient({
  initialReview,
  initialDiff,
}: {
  initialReview: ReviewDetail;
  initialDiff: ReviewDiff;
}) {
  const [review, setReview] = useState(initialReview);
  const [diff, setDiff] = useState(initialDiff);
  const [summaryDraft, setSummaryDraft] = useState(initialReview.summary || "");
  const [newThreadAnchorId, setNewThreadAnchorId] = useState<string | null>(null);
  const [newThreadContent, setNewThreadContent] = useState("");
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = async () => {
    const [nextReview, nextDiff] = await Promise.all([
      jsonFetch<ReviewDetail>(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}`),
      jsonFetch<ReviewDiff>(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/diff`),
    ]);
    setReview(nextReview);
    setDiff(nextDiff);
  };

  const runAction = (fn: () => Promise<void>) => {
    setError(null);
    startTransition(() => {
      fn().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    });
  };

  const threadsByAnchor = new Map(diff.threads.map((thread) => [thread.diffAnchor.anchorId, thread]));
  const legacyThreads = diff.threads.filter((thread) => !diff.scoreRegions.some((region) => region.anchorId === thread.diffAnchor.anchorId));
  const visualDiffUrl = `/score-editor/index.html?compareLeft=${encodeURIComponent(
    `/api/score-editor/ots/works/${encodeURIComponent(review.workId)}/sources/${encodeURIComponent(review.sourceId)}/canonical.xml?r=${encodeURIComponent(review.baseRevisionId)}`,
  )}&compareRight=${encodeURIComponent(
    `/api/score-editor/ots/works/${encodeURIComponent(review.workId)}/sources/${encodeURIComponent(review.sourceId)}/canonical.xml?r=${encodeURIComponent(review.headRevisionId)}`,
  )}&leftLabel=${encodeURIComponent(`Rev #${review.baseSequenceNumber}`)}&rightLabel=${encodeURIComponent(
    `Rev #${review.headSequenceNumber}`,
  )}&changeReviewId=${encodeURIComponent(review.reviewId)}`;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = event.data && typeof event.data === "object" ? event.data as { type?: string; reviewId?: string } : null;
      if (!data || data.type !== "ots.change-review.updated" || data.reviewId !== review.reviewId) {
        return;
      }
      void refresh().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [review.reviewId]);

  const renderThread = (thread: ReviewDiff["threads"][number]) => (
    <div className="border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-100">Thread</span>
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {thread.status}
          </span>
        </div>
        {review.permissions.canResolve ? (
          <button
            onClick={() =>
              runAction(async () => {
                await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/threads/${encodeURIComponent(thread.threadId)}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    status: thread.status === "open" ? "resolved" : "open",
                  }),
                });
                await refresh();
              })
            }
            className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {thread.status === "open" ? "Resolve" : "Reopen"}
          </button>
        ) : null}
      </div>
      <div className="space-y-2">
        {thread.comments.map((comment) => (
          <div key={comment.commentId} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {comment.username || comment.userId} · {new Date(comment.createdAt).toLocaleString()}
              {comment.editedAt ? " · edited" : ""}
            </div>
            <div className="mt-1 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-200">
              {comment.content}
            </div>
          </div>
        ))}
      </div>
      {review.permissions.canReply ? (
        <div className="mt-3">
          {replyThreadId === thread.threadId ? (
            <div className="space-y-2">
              <textarea
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                rows={3}
                placeholder="Write a reply"
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    runAction(async () => {
                      await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/threads/${encodeURIComponent(thread.threadId)}/comments`, {
                        method: "POST",
                        body: JSON.stringify({ content: replyContent }),
                      });
                      setReplyThreadId(null);
                      setReplyContent("");
                      await refresh();
                    })
                  }
                  className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
                  disabled={isPending}
                >
                  Reply
                </button>
                <button
                  onClick={() => {
                    setReplyThreadId(null);
                    setReplyContent("");
                  }}
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setReplyThreadId(thread.threadId);
                setReplyContent("");
              }}
              className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Reply
            </button>
          )}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-6">
      <section className="grid gap-3 md:grid-cols-4">
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

      {error ? (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </div>
      ) : null}

      {(review.permissions.canSubmit || review.permissions.canClose || review.permissions.canWithdraw) ? (
        <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Review Actions</h2>
            {isPending ? <span className="text-xs text-slate-500 dark:text-slate-400">Working...</span> : null}
          </div>
          {review.permissions.canSubmit ? (
            <div className="space-y-3">
              <textarea
                value={summaryDraft}
                onChange={(e) => setSummaryDraft(e.target.value)}
                rows={4}
                placeholder="Optional review summary"
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    runAction(async () => {
                      await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/submit`, {
                        method: "POST",
                        body: JSON.stringify({ summary: summaryDraft }),
                      });
                      await refresh();
                    })
                  }
                  className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
                  disabled={isPending}
                >
                  Submit Review
                </button>
                {review.permissions.canWithdraw ? (
                  <button
                    onClick={() =>
                      runAction(async () => {
                        await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/withdraw`, {
                          method: "POST",
                        });
                        await refresh();
                      })
                    }
                    className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    disabled={isPending}
                  >
                    Withdraw Review
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {review.permissions.canClose ? (
                <button
                  onClick={() =>
                    runAction(async () => {
                      await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/close`, {
                        method: "POST",
                      });
                      await refresh();
                    })
                  }
                  className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  disabled={isPending}
                >
                  Close Review
                </button>
              ) : null}
              {review.permissions.canWithdraw ? (
                <button
                  onClick={() =>
                    runAction(async () => {
                      await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/withdraw`, {
                        method: "POST",
                      });
                      await refresh();
                    })
                  }
                  className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  disabled={isPending}
                >
                  Withdraw Review
                </button>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Score Visual Diff</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Rev #{review.baseSequenceNumber} vs Rev #{review.headSequenceNumber}
          </span>
        </div>
        <iframe
          src={visualDiffUrl}
          title="Score visual diff"
          className="h-[820px] w-full rounded border border-slate-200 dark:border-slate-800"
        />
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Changed Score Regions</h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {diff.scoreRegions.length} region{diff.scoreRegions.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="space-y-6">
          {diff.scoreRegions.map((region) => {
            const thread = threadsByAnchor.get(region.anchorId);
            const regionClasses =
              region.changeType === "added"
                ? "bg-emerald-50 dark:bg-emerald-950/20"
                : region.changeType === "removed"
                  ? "bg-rose-50 dark:bg-rose-950/20"
                  : "bg-amber-50 dark:bg-amber-950/20";
            return (
              <div key={region.anchorId} className={`overflow-hidden rounded border border-slate-200 dark:border-slate-800 ${regionClasses}`}>
                <div className="flex items-start justify-between gap-4 px-4 py-3">
                  <div>
                    <div className="font-medium text-slate-900 dark:text-slate-100">{region.label}</div>
                    <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">{region.summary}</div>
                  </div>
                  {!thread && region.commentable && review.permissions.canAddThread ? (
                    <button
                      onClick={() => {
                        setNewThreadAnchorId(region.anchorId);
                        setNewThreadContent("");
                      }}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      Add Thread
                    </button>
                  ) : null}
                </div>
                {newThreadAnchorId === region.anchorId ? (
                  <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
                    <textarea
                      value={newThreadContent}
                      onChange={(e) => setNewThreadContent(e.target.value)}
                      rows={3}
                      placeholder="Write a review comment on this score change"
                      className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() =>
                          runAction(async () => {
                            await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/threads`, {
                              method: "POST",
                              body: JSON.stringify({
                                anchorId: region.anchorId,
                                content: newThreadContent,
                              }),
                            });
                            setNewThreadAnchorId(null);
                            setNewThreadContent("");
                            await refresh();
                          })
                        }
                        className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
                        disabled={isPending}
                      >
                        Save Thread
                      </button>
                      <button
                        onClick={() => {
                          setNewThreadAnchorId(null);
                          setNewThreadContent("");
                        }}
                        className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
                {thread ? renderThread(thread) : null}
              </div>
            );
          })}
          {diff.scoreRegions.length === 0 ? (
            <div className="rounded border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              No score regions were identified for this revision pair.
            </div>
          ) : null}
        </div>
      </section>

      {legacyThreads.length > 0 ? (
        <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Legacy Threads</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {legacyThreads.length} thread{legacyThreads.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-4">
            {legacyThreads.map((thread) => (
              <div key={thread.threadId} className="overflow-hidden rounded border border-slate-200 dark:border-slate-800">
                <div className="bg-slate-100 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {thread.diffAnchor.lineText}
                </div>
                {renderThread(thread)}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <details className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
        <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
          Technical Diff Fallback
        </summary>
        <div className="mt-4 space-y-6">
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
                      <div className="grid grid-cols-[5rem_5rem_1fr_auto] gap-3 px-3 py-2 font-mono text-xs">
                        <span className="text-slate-400">{line.oldLineNumber ?? ""}</span>
                        <span className="text-slate-400">{line.newLineNumber ?? ""}</span>
                        <code className="whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
                          <span className="mr-2 text-slate-400">
                            {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                          </span>
                          {line.content}
                        </code>
                        {thread ? <span className="text-[11px] text-slate-500 dark:text-slate-400">threaded</span> : null}
                      </div>
                      {thread ? renderThread(thread) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
