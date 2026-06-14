"use client";

import { useCallback, useEffect, useState, useTransition } from "react";

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
  patchsets?: Array<{
    patchsetNumber: number;
    baseSequenceNumber: number;
    headSequenceNumber: number;
    createdAt: string;
  }>;
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
  const [selectedPatchset, setSelectedPatchset] = useState<number | null>(null);
  const [selectedRegionAnchorId, setSelectedRegionAnchorId] = useState<string | null>(
    initialDiff.scoreRegions[0]?.anchorId ?? null,
  );
  const [newThreadAnchorId, setNewThreadAnchorId] = useState<string | null>(null);
  const [newThreadContent, setNewThreadContent] = useState("");
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async (patchset?: number | null) => {
    const ps = patchset ?? selectedPatchset;
    const diffUrl = ps != null
      ? `/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/diff?patchset=${ps}`
      : `/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/diff`;
    const [nextReview, nextDiff] = await Promise.all([
      jsonFetch<ReviewDetail>(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}`),
      jsonFetch<ReviewDiff>(diffUrl),
    ]);
    setReview(nextReview);
    setDiff(nextDiff);
  }, [review.reviewId, selectedPatchset]);

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
  const selectedRegion = diff.scoreRegions.find((region) => region.anchorId === selectedRegionAnchorId)
    ?? diff.scoreRegions[0]
    ?? null;
  const selectedRegionThread = selectedRegion ? threadsByAnchor.get(selectedRegion.anchorId) : undefined;
  const patchsets = review.patchsets ?? [];
  const activePatchset = selectedPatchset != null
    ? patchsets.find((ps) => ps.patchsetNumber === selectedPatchset)
    : null;
  const diffBaseSeq = activePatchset?.baseSequenceNumber ?? review.baseSequenceNumber;
  const diffHeadSeq = activePatchset?.headSequenceNumber ?? review.headSequenceNumber;
  const isSingleRevisionReview = review.baseRevisionId === review.headRevisionId;
  const scoreUrl = (revisionId: string) =>
    `/api/score-editor/ots/works/${encodeURIComponent(review.workId)}/sources/${encodeURIComponent(review.sourceId)}/canonical.xml?r=${encodeURIComponent(revisionId)}`;
  const visualDiffUrl = isSingleRevisionReview
    ? `/score-editor/index.html?reviewScore=${encodeURIComponent(scoreUrl(diff.headRevisionId))}&reviewLabel=${encodeURIComponent(
      `Rev #${diffHeadSeq}`,
    )}&changeReviewId=${encodeURIComponent(review.reviewId)}${selectedPatchset != null ? `&patchset=${selectedPatchset}` : ''}`
    : `/score-editor/index.html?compareLeft=${encodeURIComponent(scoreUrl(diff.baseRevisionId))}&compareRight=${encodeURIComponent(
      scoreUrl(diff.headRevisionId),
    )}&leftLabel=${encodeURIComponent(`Rev #${diffBaseSeq}`)}&rightLabel=${encodeURIComponent(
      `Rev #${diffHeadSeq}`,
    )}&changeReviewId=${encodeURIComponent(review.reviewId)}${selectedPatchset != null ? `&patchset=${selectedPatchset}` : ''}`;

  useEffect(() => {
    if (!diff.scoreRegions.some((region) => region.anchorId === selectedRegionAnchorId)) {
      setSelectedRegionAnchorId(diff.scoreRegions[0]?.anchorId ?? null);
    }
  }, [diff.scoreRegions, selectedRegionAnchorId]);

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
  }, [refresh, review.reviewId]);

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

      {patchsets.length > 1 && (
        <section className="rounded border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Rounds</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {patchsets.length} round{patchsets.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {patchsets.map((ps) => {
              const isSelected = selectedPatchset === ps.patchsetNumber
                || (selectedPatchset == null && ps.patchsetNumber === patchsets[patchsets.length - 1].patchsetNumber);
              return (
                <button
                  key={ps.patchsetNumber}
                  onClick={() => {
                    const next = ps.patchsetNumber === patchsets[patchsets.length - 1].patchsetNumber ? null : ps.patchsetNumber;
                    setSelectedPatchset(next);
                    runAction(async () => { await refresh(next); });
                  }}
                  disabled={isPending}
                  className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    isSelected
                      ? "border-cyan-500 bg-cyan-50 text-cyan-800 dark:border-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-200"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                  }`}
                >
                  Round {ps.patchsetNumber}
                  <span className="ml-1 text-[10px] text-slate-500 dark:text-slate-400">
                    (Rev {ps.baseSequenceNumber}→{ps.headSequenceNumber})
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-semibold">Review score</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isSingleRevisionReview
                ? "Select any bar in the score to read or leave a focused comment."
                : "Review changes between the base and head revisions and leave focused thread comments."}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{isSingleRevisionReview ? `Rev #${diffHeadSeq}` : `Rev #${diffBaseSeq} vs Rev #${diffHeadSeq}`}</span>
            <span aria-hidden="true">·</span>
            <span>{diff.scoreRegions.length} changed bar{diff.scoreRegions.length === 1 ? "" : "s"}</span>
          </div>
        </div>

        <div className="min-h-[820px]">
          <div className="min-w-0 bg-slate-100 p-3 dark:bg-slate-950/60">
            <iframe
              key={`${diff.baseRevisionId}-${diff.headRevisionId}`}
              src={visualDiffUrl}
              title="Score visual diff"
              className="h-[820px] w-full rounded-lg border border-slate-200 bg-white dark:border-slate-800"
            />
          </div>

          <aside className="hidden">
            <div className="border-b border-slate-200 p-3 dark:border-slate-800">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Changed bars</h3>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  {diff.threads.filter((thread) => thread.status === "open").length} open
                </span>
              </div>
              <div className="flex max-h-64 gap-2 overflow-auto pb-1 lg:flex-col lg:pb-0">
                {diff.scoreRegions.map((region) => {
                  const thread = threadsByAnchor.get(region.anchorId);
                  const isSelected = selectedRegion?.anchorId === region.anchorId;
                  const changeDot =
                    region.changeType === "added"
                      ? "bg-emerald-500"
                      : region.changeType === "removed"
                        ? "bg-rose-500"
                        : "bg-amber-500";
                  return (
                    <button
                      key={region.anchorId}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setSelectedRegionAnchorId(region.anchorId);
                        setNewThreadAnchorId(null);
                        setNewThreadContent("");
                      }}
                      className={`min-w-56 rounded-lg border px-3 py-2.5 text-left transition-colors lg:min-w-0 ${
                        isSelected
                          ? "border-cyan-500 bg-cyan-50 ring-1 ring-cyan-500 dark:border-cyan-500 dark:bg-cyan-950/30"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/70"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${changeDot}`} />
                        <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{region.label}</span>
                        {thread ? (
                          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                            thread.status === "open"
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
                              : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                          }`}>
                            {thread.status}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-500 dark:text-slate-400">{region.summary}</span>
                    </button>
                  );
                })}
                {diff.scoreRegions.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 px-3 py-5 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    No musically changed bars were identified for this revision pair.
                  </div>
                ) : null}
              </div>
            </div>

            {selectedRegion ? (
              <div className="lg:sticky lg:top-4">
                <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Selected bar
                      </div>
                      <div className="mt-1 font-semibold text-slate-900 dark:text-slate-100">{selectedRegion.label}</div>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {selectedRegion.changeType}
                    </span>
                  </div>
                  <p className="mt-2 break-words text-xs leading-5 text-slate-600 dark:text-slate-400">{selectedRegion.summary}</p>
                </div>

                {!selectedRegionThread && selectedRegion.commentable && review.permissions.canAddThread ? (
                  <div className="p-4">
                    {newThreadAnchorId === selectedRegion.anchorId ? (
                      <div>
                        <textarea
                          autoFocus
                          value={newThreadContent}
                          onChange={(e) => setNewThreadContent(e.target.value)}
                          rows={5}
                          placeholder="Write a review comment on this score change"
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() =>
                              runAction(async () => {
                                await jsonFetch(`/api/proxy/change-reviews/${encodeURIComponent(review.reviewId)}/threads`, {
                                  method: "POST",
                                  body: JSON.stringify({
                                    anchorId: selectedRegion.anchorId,
                                    content: newThreadContent,
                                  }),
                                });
                                setNewThreadAnchorId(null);
                                setNewThreadContent("");
                                await refresh();
                              })
                            }
                            className="rounded bg-cyan-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
                            disabled={isPending || !newThreadContent.trim()}
                          >
                            Comment
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
                    ) : (
                      <button
                        onClick={() => {
                          setNewThreadAnchorId(selectedRegion.anchorId);
                          setNewThreadContent("");
                        }}
                        className="w-full rounded-lg bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
                      >
                        Comment on this bar
                      </button>
                    )}
                  </div>
                ) : null}
                {selectedRegionThread ? renderThread(selectedRegionThread) : null}
              </div>
            ) : null}
          </aside>
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
