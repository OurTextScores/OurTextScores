"use client";

import type { StepState, StepStatus } from "./progress-steps";

export type UploadProgressStatus = "idle" | "running" | "success" | "error";

export interface UploadProgressEvent {
  message: string;
  stage?: string;
  timestamp?: string;
}

export function UploadProgressStepper({
  steps,
  events,
  status
}: {
  steps: StepState[];
  events: UploadProgressEvent[];
  status: UploadProgressStatus;
}) {
  return (
    <div className="rounded border border-slate-200 bg-white p-3 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        <span>Processing</span>
        {status === "error" && (
          <span className="text-rose-500 dark:text-rose-300">Failed</span>
        )}
        {status === "success" && (
          <span className="text-emerald-500 dark:text-emerald-300">Completed</span>
        )}
      </div>
      <ul className="space-y-1 text-xs">
        {steps
          .filter((s) => !s.optional || s.status !== "pending")
          .map((s) => {
            const latestForStage = events.filter((e) => e.stage === s.id).slice(-1)[0];
            const showError =
              s.status === "failed" &&
              (s.id === "pipeline.error" || s.id === "fossil.failed");
            return (
              <li key={s.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <StatusIcon status={s.status} />
                  <span className="flex-1 truncate" title={s.label}>
                    {s.label}
                  </span>
                  {typeof s.ms === "number" && (
                    <span className="tabular-nums text-slate-500">
                      {(s.ms / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
                {showError && latestForStage?.message && (
                  <div className="ml-5 text-[11px] text-rose-600 dark:text-rose-300">
                    <span
                      className="inline-block max-w-xs truncate align-middle"
                      title={latestForStage.message}
                    >
                      {latestForStage.message}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  const base = "h-3 w-3 inline-block";
  switch (status) {
    case "done":
      return (
        <svg className={`${base} text-emerald-600`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.414l2.293 2.293 6.543-6.543a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "failed":
      return (
        <svg className={`${base} text-rose-600`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm-1-5a1 1 0 112 0 1 1 0 01-2 0zm0-6a1 1 0 012 0v4a1 1 0 11-2 0V7z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "skipped":
      return (
        <svg className={`${base} text-slate-400`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path d="M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "active":
      return (
        <span className={`relative ${base}`}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-600" />
        </span>
      );
    default:
      return <span className={`${base} rounded-full bg-slate-300 dark:bg-slate-600`} />;
  }
}

