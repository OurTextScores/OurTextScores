"use client";

import { useCallback, useEffect, useState } from "react";

interface Alternative {
  value: string;
  confidence: number;
}

interface Spot {
  id: number;
  head: string;
  chosen: string;
  confidence: number;
  alternatives: Alternative[];
}

interface Review {
  pageNumber: number;
  spots: Spot[];
  remainingFloor: number | null;
  suitability: { symbols: number; spots: number; askableRatio: number; unsuitable: boolean };
}

const HEAD_LABELS: Record<string, string> = {
  pitch: "Which note is this?",
  rhythm: "Which duration is this?",
  lift: "Which accidental is this?",
  articulation: "Which articulation is this?",
  slur: "Is this slurred?",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default function PageReview({
  jobId,
  pageNumber,
}: {
  jobId: string;
  pageNumber: number;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [position, setPosition] = useState(0);
  const [level, setLevel] = useState<"staff" | "page">("staff");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPosition(0);
    fetch(`/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/review`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setReview(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, pageNumber]);

  // Reset the zoom when moving on: the previous spot's context says nothing
  // about the next one.
  const advance = useCallback(() => {
    setPosition((current) => current + 1);
    setLevel("staff");
  }, []);

  if (loading) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">Loading review…</p>
    );
  }
  if (!review || review.spots.length === 0) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Nothing on this page looked uncertain.
      </p>
    );
  }

  const spot = review.spots[position];
  const remaining = review.spots.length - position;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Check the uncertain spots
        </h3>
        {spot && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            spot {position + 1} of {review.spots.length}, least certain first
          </span>
        )}
      </div>

      {review.suitability.unsuitable && (
        // Say so rather than presenting hundreds of questions as though the page
        // were nearly right. Never a gate: the queue is still below.
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          The scanner was unsure about {percent(review.suitability.askableRatio)} of this
          page, so it is probably past what automatic recognition can do — handwritten
          or heavily marked scores usually are. You can still work through the list,
          but the Score Editor may be faster.
        </p>
      )}

      {!spot ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          That is everything flagged on this page.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/crop/${spot.id}?level=${level}`}
              alt={`Page ${pageNumber}, the passage the scanner was unsure about`}
              className="max-h-80 w-full object-contain"
            />
          </div>
          <div className="mt-2 flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setLevel(level === "staff" ? "page" : "staff")}
              className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {level === "staff" ? "Show the whole page" : "Back to this staff"}
            </button>
          </div>

          <p className="mt-4 text-sm font-medium text-slate-900 dark:text-slate-100">
            {HEAD_LABELS[spot.head] || "What is this?"}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            <li className="flex items-center gap-2 text-slate-900 dark:text-slate-100">
              <span className="font-mono">{spot.chosen}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {percent(spot.confidence)} — what the scanner chose
              </span>
            </li>
            {spot.alternatives.map((alternative) => (
              <li
                key={alternative.value}
                className="flex items-center gap-2 text-slate-700 dark:text-slate-300"
              >
                <span className="font-mono">{alternative.value}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {percent(alternative.confidence)}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {/* The number that makes stopping a judgement rather than fatigue:
                it rises as the queue is worked. */}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {remaining - 1 > 0
                ? `${remaining - 1} more after this, all at least ${percent(
                    review.spots[position + 1]?.confidence ?? spot.confidence,
                  )} confident`
                : "This is the last one flagged."}
            </p>
            <button
              type="button"
              onClick={advance}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
