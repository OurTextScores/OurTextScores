"use client";

import { useEffect, useState } from "react";
import PageComparison from "../../../page-comparison";
import { ScannerJob } from "../../../../scanner-types";

/**
 * Loads the job so the comparison has the engine plan it needs.
 *
 * The job page holds this in state already; a page of its own has to fetch it,
 * and there is nothing else worth showing until it arrives — the comparison is
 * the whole page.
 */
export default function ComparePageClient({
  jobId,
  pageNumber,
}: {
  jobId: string;
  pageNumber: number;
}) {
  const [job, setJob] = useState<ScannerJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return response.json();
      })
      .then((value) => {
        if (!cancelled) setJob(value);
      })
      .catch((value) => {
        if (!cancelled) {
          setError(value instanceof Error ? value.message : String(value));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800"
      >
        {error}
      </div>
    );
  }
  if (!job) return <p className="text-sm text-slate-500">Loading scan…</p>;

  const page = job.pages.find((entry) => entry.pageNumber === pageNumber);
  if (!page) {
    return (
      <p className="text-sm text-slate-500">
        This scan has no page {pageNumber}.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="break-all text-2xl font-bold text-slate-900 dark:text-slate-100">
          {job.originalFilename}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Page {page.ordinal}</p>
      </div>
      <PageComparison jobId={jobId} job={job} page={page} open />
    </div>
  );
}
