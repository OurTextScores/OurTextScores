"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScannerJob } from "../scanner-types";
import PageReview from "./page-review";
import PageComparison from "./page-comparison";

const STEPS = ["base", "heads", "engines"] as const;
const LABELS = {
  base: "Base recognition review",
  heads: "Merge additional heads",
  engines: "Merge between engines",
};
type Step = (typeof STEPS)[number];

export default function ReviewWorkflow({
  job,
  page,
  onChange,
}: {
  job: ScannerJob;
  page: ScannerJob["pages"][number];
  onChange: (job: ScannerJob) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<Record<string, boolean>>({});
  const onReviewBusy = useCallback((id: string, value: boolean) => {
    setReviewBusy((current) =>
      current[id] === value ? current : { ...current, [id]: value },
    );
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [families, setFamilies] = useState<string[] | null>(null);
  const workflow = page.reviewWorkflow;
  const active = workflow?.active || "base";
  const run = page.engines?.["ots-homr"];
  const selected =
    families ??
    (run?.selectedStructuredHeadFamilies?.length
      ? run.selectedStructuredHeadFamilies
      : run?.availableStructuredHeadFamilies || []);
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(job.jobId)}`;
  const pending =
    Object.values(reviewBusy).some(Boolean) ||
    Boolean(
      Object.values(page.engines || {}).some(
        (run) => run?.structuredOutputPending,
      ),
    );
  const hasWorkflow = Boolean(workflow);
  const engines = (
    job.enginePlan?.engineIds || Object.keys(page.engines || {})
  ).filter(
    (id) =>
      page.engines?.[id]?.status === "succeeded" &&
      page.engines?.[id]?.hasMusicXml,
  );
  useEffect(() => {
    if (!hasWorkflow || active === "base") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetch(base, { cache: "no-store" })
        .then(async (response) => {
          if (response.ok && !cancelled) onChange(await response.json());
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, base, onChange, hasWorkflow]);
  const transition = async (action: string, step?: Step) => {
    setBusy(true);
    setError(null);
    try {
      // A renderer or worker may have saved since this page was loaded.
      const fresh = await fetch(base, { cache: "no-store" });
      if (!fresh.ok) throw new Error("Unable to refresh this scan.");
      const latest: ScannerJob = await fresh.json();
      const current = latest.pages.find(
        (entry) => entry.pageNumber === page.pageNumber,
      );
      if (current?.reviewWorkflow?.revision !== workflow?.revision) {
        onChange(latest);
        throw new Error(
          "The review step changed in another tab. The latest state is now shown.",
        );
      }
      const response = await fetch(
        `${base}/pages/${page.pageNumber}/review-workflow`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            step,
            statusVersion: latest.statusVersion || 1,
            workflowStateVersion: current?.reviewWorkflow?.stateVersion ?? null,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.message || "Unable to save this review step.");
      setFamilies(null);
      onChange(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveProgress = async (
    engineId: string,
    position: number,
    contentSignature: string,
  ) => {
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to save review progress.");
    const latest: ScannerJob = await response.json();
    if (
      latest.pages.find((entry) => entry.pageNumber === page.pageNumber)
        ?.reviewWorkflow?.revision !== workflow?.revision
    )
      throw new Error(
        "The review step changed in another tab. Refresh to continue.",
      );
    const saved = await fetch(
      `${base}/pages/${page.pageNumber}/review-workflow`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "progress",
          statusVersion: latest.statusVersion || 1,
          workflowStateVersion:
            latest.pages.find((entry) => entry.pageNumber === page.pageNumber)
              ?.reviewWorkflow?.stateVersion ?? null,
          engineId,
          position,
          contentSignature,
        }),
      },
    );
    const result = await saved.json();
    if (!saved.ok)
      throw new Error(result.message || "Unable to save review progress.");
    onChange(result);
  };
  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `${base}/pages/${page.pageNumber}/engines/ots-homr/structured-output`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ families: selected }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message || "Unable to prepare additional heads.",
        );
      onChange(result);
      setFamilies(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const keepBase = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await fetch(`${base}/pages/${page.pageNumber}/merged`, {
        cache: "no-store",
      });
      if (!current.ok) throw new Error("Unable to load the saved merge.");
      const merged = await current.json();
      const response = await fetch(
        `${base}/pages/${page.pageNumber}/merged/source`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engineId: "ots-homr-core",
            baseEngine: "ots-homr-core",
            candidateEngine: "ots-homr-selected-heads",
            revision: merged.revision,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message || "Unable to save the base recognition.",
        );
      const refreshed = await fetch(base, { cache: "no-store" });
      if (refreshed.ok) onChange(await refreshed.json());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const prepared = Boolean(
    run?.artifactKinds?.includes("selected-heads-musicxml") &&
      run.selectedStructuredHeadFamilies?.length,
  );
  const completed = workflow?.steps.engines.complete;

  return (
    <section
      aria-label="Guided scan review"
      className="mt-5 rounded-xl border border-cyan-200 p-4 dark:border-cyan-900"
    >
      <h3 className="text-lg font-semibold">Review this page</h3>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Review the recognition, merge optional features, then reconcile engines.
        Each step keeps its own saved work. Revisit any available step to change
        it.
      </p>
      <ol className="my-4 grid gap-2 sm:grid-cols-3">
        {STEPS.map((step, index) => (
          <li
            key={step}
            className={`rounded-lg border p-3 ${workflow && active === step ? "border-cyan-600 bg-cyan-50 dark:bg-cyan-950" : "border-slate-200 dark:border-slate-700"}`}
          >
            <button
              type="button"
              disabled={
                busy || pending || !workflow || !workflow.steps[step].available
              }
              aria-current={workflow && active === step ? "step" : undefined}
              onClick={() =>
                void transition(
                  workflow?.steps[step].stale ? "redo" : "open",
                  step,
                )
              }
              className="text-left text-sm font-semibold disabled:opacity-50"
            >
              {index + 1}. {LABELS[step]}
            </button>
            <p className="mt-1 text-xs text-slate-500">
              {workflow?.steps[step].stale
                ? "Saved work needs updated input"
                : workflow?.steps[step].complete
                  ? workflow.steps[step].skipped
                    ? "Skipped · saved"
                    : "Completed · saved"
                  : workflow?.steps[step].saved
                    ? "In progress · saved"
                    : "Not started"}
            </p>
            {workflow?.steps[step].saved && workflow.steps[step].available && (
              <button
                type="button"
                disabled={busy || pending}
                onClick={() => void transition("redo", step)}
                className="mt-2 mr-3 text-xs text-cyan-700 underline disabled:opacity-50"
              >
                Redo {index + 1}
              </button>
            )}
            {workflow?.steps[step].hasPreviousResult && (
              <a
                href={`${base}/pages/${page.pageNumber}/review-workflow/${step}/previous/musicxml`}
                download
                className="text-xs text-cyan-700 underline"
              >
                Download previous result
              </a>
            )}
            {workflow?.steps[step].stale && (
              <span className="text-xs">
                Open to redo with updated input; the previous result is
                retained.
              </span>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p role="alert" className="my-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {!workflow ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void transition("start")}
          className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Start guided review
        </button>
      ) : (
        <>
          {active === "base" && (
            <div className="space-y-3">
              {engines
                .filter(
                  (id) =>
                    job.enginePlan?.capabilitySnapshots[id]?.supportsSpotReview,
                )
                .map((id) => (
                  <PageReview
                    key={`${id}-${workflow.revision}`}
                    jobId={job.jobId}
                    pageNumber={page.pageNumber}
                    engineId={id}
                    onBusyChange={onReviewBusy}
                    onProgress={(position, signature) =>
                      saveProgress(id, position, signature)
                    }
                    engineLabel={
                      job.enginePlan?.capabilitySnapshots[id]?.displayName || id
                    }
                  />
                ))}
            </div>
          )}
          {active === "heads" && (
            <>
              <p className="mb-3 text-sm">
                Choose the features to review against your corrected base
                recognition. The result you save here becomes OTS-HOMR’s reading
                in step 3.
              </p>
              {!page.hasMergedScore && (
                <fieldset disabled={busy || pending} className="mb-4 space-y-3">
                  <legend className="text-sm font-semibold">
                    Additional heads
                  </legend>
                  <div className="flex flex-wrap gap-4">
                    {(run?.availableStructuredHeadFamilies || []).map(
                      (family) => (
                        <label key={family} className="text-sm">
                          <input
                            type="checkbox"
                            checked={selected.includes(family)}
                            onChange={() =>
                              setFamilies(
                                selected.includes(family)
                                  ? selected.filter((item) => item !== family)
                                  : [...selected, family],
                              )
                            }
                            className="mr-1"
                          />
                          {(
                            {
                              beam: "Beams",
                              advance: "Rhythmic spacing",
                              stem: "Stem direction",
                              tie: "Ties",
                              slur: "Slurs",
                            } as Record<string, string>
                          )[family] || family}
                        </label>
                      ),
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy || pending || !selected.length}
                    onClick={() => void prepare()}
                    className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
                  >
                    {pending
                      ? "Preparing additional heads…"
                      : "Prepare additional heads merge"}
                  </button>
                </fieldset>
              )}
              {run?.structuredOutputError && (
                <p role="alert" className="text-sm text-red-700">
                  {run.structuredOutputError}
                </p>
              )}
              {prepared && !pending && !page.hasMergedScore && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void keepBase()}
                  className="mb-3 rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
                >
                  Keep base recognition for this step
                </button>
              )}
              {prepared && !pending && (
                <PageComparison
                  key={`heads-${workflow.revision}-${run?.selectedStructuredHeadFamilies?.join()}`}
                  jobId={job.jobId}
                  job={job}
                  page={page}
                  open
                  initialBaseEngine="ots-homr-core"
                  initialCandidateEngine="ots-homr-selected-heads"
                  fixedPair
                />
              )}
              {!prepared && !pending && (
                <p className="text-sm text-slate-500">
                  You can also continue using the base recognition without
                  additional heads.
                </p>
              )}
            </>
          )}
          {active === "engines" &&
            (engines.length >= 2 ? (
              <PageComparison
                key={`engines-${workflow.revision}`}
                jobId={job.jobId}
                job={job}
                page={page}
                open
                initialBaseEngine={
                  engines.includes("ots-homr") ? "ots-homr" : engines[0]
                }
                initialCandidateEngine={
                  engines.find((id) => id !== "ots-homr") || engines[1]
                }
              />
            ) : (
              <p className="text-sm">
                Only one engine has a reading for this page. You can finish with
                the reviewed result.
              </p>
            ))}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
            <button
              type="button"
              disabled={
                busy ||
                pending ||
                (active === "heads" && Boolean(run?.structuredOutputError)) ||
                (active === "engines" && completed)
              }
              onClick={() => void transition("complete")}
              className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy
                ? "Saving…"
                : active === "base"
                  ? "Save base review and continue"
                  : active === "heads"
                    ? "Save additional heads and continue"
                    : completed
                      ? "Review complete · saved"
                      : "Finish review"}
            </button>
            {!(active === "engines" && completed) && (
              <button
                type="button"
                disabled={busy || pending}
                onClick={() => void transition("skip")}
                className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
              >
                {active === "base"
                  ? "Skip base review"
                  : active === "heads"
                    ? "Skip additional heads"
                    : "Skip engine merge"}
              </button>
            )}
            <span className="text-xs text-slate-500">
              {active === "base"
                ? "Skip keeps your saved answers and leaves remaining questions unanswered."
                : "Skip keeps the incoming reading and retains this stage’s merge work as a previous result."}{" "}
              Continue saves a checkpoint for this step.
            </span>
          </div>
        </>
      )}
    </section>
  );
}
