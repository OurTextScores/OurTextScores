"use client";

import { useState, useEffect } from "react";

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

export default function RevisionRating({
  workId,
  sourceId,
  revisionId,
  currentUser
}: {
  workId: string;
  sourceId: string;
  revisionId: string;
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

  // Check if user has already rated
  useEffect(() => {
    if (!currentUser) {
      setLoadingCheck(false);
      return;
    }

    async function checkRating() {
      try {
        const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/ratings/check`);
        if (res.ok) {
          const data = await res.json();
          setHasRated(data.hasRated);
          if (data.hasRated) {
            // Auto-load ratings if user has already rated
            await loadRatings();
          }
        }
      } catch (err) {
        console.error("Failed to check rating status:", err);
      } finally {
        setLoadingCheck(false);
      }
    }

    checkRating();
  }, [workId, sourceId, revisionId, currentUser]);

  const loadRatings = async () => {
    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/ratings`);
      if (res.ok) {
        const data = await res.json();
        setRatingData(data);
        setShowRatings(true);
      } else {
        setError("Failed to load ratings");
      }
    } catch (err) {
      console.error("Failed to load ratings:", err);
      setError("Failed to load ratings");
    }
  };

  const handleRatingSubmit = async () => {
    if (!selectedRating || !currentUser) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/proxy/works/${workId}/sources/${sourceId}/revisions/${revisionId}/rate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ rating: selectedRating })
      });

      if (res.ok) {
        setHasRated(true);
        await loadRatings(); // Load histogram after successful rating
      } else {
        const data = await res.json();
        setError(data.message || "Failed to submit rating");
      }
    } catch (err) {
      console.error("Failed to submit rating:", err);
      setError("Failed to submit rating");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loadingCheck) {
    return (
      <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
        <div className="text-xs text-slate-500 dark:text-slate-400">Loading...</div>
      </div>
    );
  }

  // Show ratings histogram
  if (hasRated || showRatings) {
    if (!ratingData) {
      return (
        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
          <div className="text-xs text-slate-500 dark:text-slate-400">Loading ratings...</div>
        </div>
      );
    }

    const maxCount = Math.max(...ratingData.histogram.map(h => h.userCount + h.adminCount), 1);

    return (
      <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
        <h3 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
          Rating Distribution ({ratingData.totalRatings} {ratingData.totalRatings === 1 ? 'rating' : 'ratings'})
        </h3>
        <div className="space-y-2">
          {[5, 4, 3, 2, 1].map(stars => {
            const data = ratingData.histogram.find(h => h.stars === stars);
            if (!data) return null;

            const totalCount = data.userCount + data.adminCount;
            const percentage = maxCount > 0 ? (totalCount / maxCount) * 100 : 0;
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
                <div className="flex-1 h-6 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                  <div className="h-full flex">
                    {/* User ratings (blue) */}
                    {data.userCount > 0 && (
                      <div
                        className="bg-cyan-500 dark:bg-cyan-600 transition-all"
                        style={{ width: `${userPercentage}%` }}
                        title={`${data.userCount} user ${data.userCount === 1 ? 'rating' : 'ratings'}`}
                      />
                    )}
                    {/* Admin ratings (emerald) */}
                    {data.adminCount > 0 && (
                      <div
                        className="bg-emerald-500 dark:bg-emerald-600 transition-all"
                        style={{ width: `${adminPercentage}%` }}
                        title={`${data.adminCount} admin ${data.adminCount === 1 ? 'rating' : 'ratings'}`}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-4 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 bg-cyan-500 dark:bg-cyan-600 rounded"></div>
            <span>User ratings</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 bg-emerald-500 dark:bg-emerald-600 rounded"></div>
            <span>Admin ratings</span>
          </div>
        </div>
      </div>
    );
  }

  // Show rating selector
  return (
    <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800">
      <h3 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
        Rate this Revision
      </h3>

      {error && (
        <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
          {error}
        </div>
      )}

      {!currentUser ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Sign in to rate this revision or view ratings.
          </p>
          <button
            onClick={() => loadRatings()}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Show Ratings
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-2">
            {[1, 2, 3, 4, 5].map(rating => (
              <button
                key={rating}
                onClick={() => setSelectedRating(rating)}
                onMouseEnter={() => setHoveredRating(rating)}
                onMouseLeave={() => setHoveredRating(null)}
                disabled={isSubmitting}
                className={`text-3xl transition-all disabled:opacity-50 ${
                  (hoveredRating !== null ? rating <= hoveredRating : selectedRating !== null && rating <= selectedRating)
                    ? 'text-amber-500 scale-110'
                    : 'text-slate-300 dark:text-slate-700 hover:text-amber-400'
                }`}
                title={STAR_TOOLTIPS[rating - 1]}
              >
                ★
              </button>
            ))}
          </div>

          {selectedRating && (
            <div className="text-center">
              <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                {STAR_TOOLTIPS[selectedRating - 1]}
              </p>
              <button
                onClick={handleRatingSubmit}
                disabled={isSubmitting}
                className="rounded border border-cyan-300 bg-cyan-50 px-4 py-2 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200 dark:hover:bg-cyan-900"
              >
                {isSubmitting ? 'Submitting...' : 'Submit Rating'}
              </button>
            </div>
          )}

          <button
            onClick={() => loadRatings()}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Show Ratings
          </button>
        </div>
      )}
    </div>
  );
}
