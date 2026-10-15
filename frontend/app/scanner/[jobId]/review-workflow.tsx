"use client";

import { useEffect, useState } from "react";
import type { ScannerJob } from "../scanner-types";
import PageComparison from "./page-comparison";

/** Single engine merge, with a one-time bridge for saved three-stage reviews. */
export default function EngineReview({
  job,
  page,
  onChange,
  initialBaseEngine,
  initialCandidateEngine,
}: {
  job: ScannerJob;
  page: ScannerJob["pages"][number];
  onChange: (job: ScannerJob) => void;
  initialBaseEngine?: string;
  initialCandidateEngine?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const legacyStep = page.reviewWorkflow?.active;
  const migrating = Boolean(legacyStep && legacyStep !== "engines");
  const pending = Object.values(page.engines || {}).some(
    (run) => run?.structuredOutputPending,
  );
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(job.jobId)}`;
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const response = await fetch(base, { cache: "no-store" });
      if (response.ok && !cancelled) onChange(await response.json());
    };
    const timer = window.setInterval(
      () => void refresh().catch(() => undefined),
      3000,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, onChange]);
  useEffect(() => {
    if (!migrating || pending) return;
    const controller = new AbortController();
    setError(null);
    void (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const fresh = await fetch(base, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!fresh.ok) throw new Error("Unable to load this scan.");
        const latest: ScannerJob = await fresh.json();
        const current = latest.pages.find(
          (entry) => entry.pageNumber === page.pageNumber,
        );
        if (
          current?.reviewWorkflow?.active === "engines" ||
          !current?.reviewWorkflow
        ) {
          if (!controller.signal.aborted) onChange(latest);
          return;
        }
        const response = await fetch(
          `${base}/pages/${page.pageNumber}/review-workflow`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "engine-review",
              statusVersion: latest.statusVersion || 1,
              workflowStateVersion: current.reviewWorkflow.stateVersion ?? null,
            }),
          },
        );
        const result = await response.json();
        if (response.ok) {
          if (!controller.signal.aborted) onChange(result);
          return;
        }
        if (response.status !== 409 || attempt === 2)
          throw new Error(result.message || "Unable to open the engine merge.");
      }
    })().catch((cause) => {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [base, migrating, pending, onChange, page.pageNumber, retry]);

  if (pending)
    return (
      <p role="status" className="mt-5 text-sm">
        Preparing the latest engine readings…
      </p>
    );
  if (migrating)
    return (
      <section aria-label="Engine merge" className="mt-5">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry opening merge
            </button>
          </>
        ) : (
          <p role="status">Opening the engine merge with your saved work…</p>
        )}
      </section>
    );
  const engines = (
    job.enginePlan?.engineIds || Object.keys(page.engines || {})
  ).filter(
    (id) =>
      page.engines?.[id]?.status === "succeeded" &&
      page.engines[id]?.hasMusicXml,
  );
  if (engines.length < 2)
    return (
      <div className="mt-5">
        <p className="text-sm">
          Only one engine returned a reading for this page. You can review its
          score below.
        </p>
        <PageComparison jobId={job.jobId} job={job} page={page} open />
      </div>
    );
  const first =
    initialBaseEngine && engines.includes(initialBaseEngine)
      ? initialBaseEngine
      : engines.includes("ots-homr")
        ? "ots-homr"
        : engines[0];
  return (
    <div className="mt-5" aria-label="Engine merge">
      <PageComparison
        jobId={job.jobId}
        job={job}
        page={page}
        open
        initialBaseEngine={first}
        initialCandidateEngine={
          initialCandidateEngine &&
          engines.includes(initialCandidateEngine) &&
          initialCandidateEngine !== first
            ? initialCandidateEngine
            : engines.find((id) => id !== first)
        }
      />
    </div>
  );
}
