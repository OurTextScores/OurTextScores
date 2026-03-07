"use client";

import { useEffect, useState } from "react";

interface RatingHistogram {
  stars: number;
  userCount: number;
  adminCount: number;
}

interface RatingData {
  histogram: RatingHistogram[];
  totalRatings: number;
}

const STAR_TOOLTIPS = [
  "Incorrect/inappropriate, please flag for review",
  "Slop - many errors",
  "Some errors",
  "Performance quality",
  "Urtext/Exceptional"
];

export default function BranchRating({
  workId,
  sourceId,
  branchName,
  currentUser
}: {
  workId: string;
  sourceId: string;
  branchName: string;
  currentUser?: { userId: string; email?: string; name?: string; isAdmin: boolean } | null;
}) {
  const [hasRated, setHasRated] = useState(false);
  const [showRatings, setShowRatings] = useState(false);
  const [ratingData, setRatingData] = useState<RatingData | null>(null);
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [hoveredRating, setHoveredRating] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingCheck, setLoadingCheck] = useState(true);

  useEffect(() => {
    if (!currentUser) {
      setLoadingCheck(false);
      return;
    }

    async function checkRating() {
      try {
        const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/branches/${encodeURIComponent(branchName)}/ratings/check`);
        if (res.ok) {
          const data = await res.json();
          setHasRated(data.hasRated);
          if (data.hasRated) {
            await loadRatings();
          }
        }
      } catch {
        // Ignore initial rating check failures.
      } finally {
        setLoadingCheck(false);
      }
    }

    void checkRating();
  }, [branchName, currentUser, sourceId, workId]);

  const loadRatings = async () => {
    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/branches/${encodeURIComponent(branchName)}/ratings`);
      if (res.ok) {
        const data = await res.json();
        setRatingData(data);
        setShowRatings(true);
      } else {
        setError("Failed to load ratings");
      }
    } catch {
      setError("Failed to load ratings");
    }
  };

  const handleRatingSubmit = async () => {
    if (!selectedRating || !currentUser) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/branches/${encodeURIComponent(branchName)}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: selectedRating })
      });

      if (res.ok) {
        setHasRated(true);
        await loadRatings();
      } else {
        const data = await res.json();
        setError(data.message || "Failed to submit rating");
      }
    } catch {
      setError("Failed to submit rating");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loadingCheck) {
    return <div className="text-xs text-slate-500 dark:text-slate-400">Loading ratings...</div>;
  }

  if (hasRated || showRatings) {
    if (!ratingData) {
      return <div className="text-xs text-slate-500 dark:text-slate-400">Loading ratings...</div>;
    }

    const maxCount = Math.max(...ratingData.histogram.map(h => h.userCount + h.adminCount), 1);

    return (
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Branch Ratings ({ratingData.totalRatings})
        </div>
        {[5, 4, 3, 2, 1].map(stars => {
          const data = ratingData.histogram.find(h => h.stars === stars);
          if (!data) return null;

          const totalCount = data.userCount + data.adminCount;
          const userPercentage = maxCount > 0 ? (data.userCount / maxCount) * 100 : 0;
          const adminPercentage = maxCount > 0 ? (data.adminCount / maxCount) * 100 : 0;

          return (
            <div key={stars} className="flex items-center gap-3">
              <div className="w-24 flex items-center gap-1 text-xs text-slate-700 dark:text-slate-300">
                <span className="font-semibold">{stars}</span>
                <span className="text-amber-500">★</span>
                <span className="text-slate-500 dark:text-slate-400" title={STAR_TOOLTIPS[stars - 1]}>
                  ({totalCount})
                </span>
              </div>
              <div className="flex-1 h-4 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                <div className="flex h-full">
                  {data.userCount > 0 && <div className="bg-cyan-500" style={{ width: `${userPercentage}%` }} />}
                  {data.adminCount > 0 && <div className="bg-emerald-500" style={{ width: `${adminPercentage}%` }} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Rate this branch
      </div>
      {error && (
        <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
          {error}
        </div>
      )}
      {!currentUser ? (
        <button
          onClick={() => void loadRatings()}
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          View ratings
        </button>
      ) : (
        <>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                type="button"
                onClick={() => setSelectedRating(rating)}
                onMouseEnter={() => setHoveredRating(rating)}
                onMouseLeave={() => setHoveredRating(null)}
                className={`text-2xl ${(hoveredRating ?? selectedRating ?? 0) >= rating ? "text-amber-500" : "text-slate-300 dark:text-slate-600"}`}
                title={STAR_TOOLTIPS[rating - 1]}
              >
                ★
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void handleRatingSubmit()}
            disabled={!selectedRating || isSubmitting}
            className="rounded border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200"
          >
            {isSubmitting ? "Submitting..." : "Submit rating"}
          </button>
        </>
      )}
    </div>
  );
}
