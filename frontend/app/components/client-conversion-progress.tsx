"use client";

import { useEffect, useState } from "react";
import type { ClientMsczConversionProgress } from "../lib/client-mscz-conversion";

const SLOW_CONVERSION_MS = 2 * 60 * 1000;
const STALE_HEARTBEAT_MS = 20 * 1000;
const MILESTONE_ORDER = ["prepare", "engine", "convert", "finalize", "done"] as const;
const MILESTONE_LABELS: Record<(typeof MILESTONE_ORDER)[number], string> = {
  prepare: "Prepare input",
  engine: "Load webmscore engine",
  convert: "Convert MSCZ to MXL",
  finalize: "Finalize converted file",
  done: "Ready to upload",
};

type MilestoneStatus = "pending" | "active" | "done";

function formatDurationSeconds(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

export function ClientConversionProgressCard({
  progress,
}: {
  progress: ClientMsczConversionProgress | null;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!progress) {
      return;
    }

    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress]);

  if (!progress) {
    return null;
  }

  const elapsedMs = Math.max(0, nowMs - progress.startedAtMs);
  const heartbeatLagMs = Math.max(0, nowMs - progress.heartbeatAtMs);
  const showSlowHint =
    (progress.milestone === "convert" || progress.milestone === "finalize") &&
    elapsedMs >= SLOW_CONVERSION_MS;
  const showStaleHint = progress.milestone !== "done" && heartbeatLagMs >= STALE_HEARTBEAT_MS;
  const activeIndex = MILESTONE_ORDER.indexOf(progress.milestone);

  const engineLabel =
    progress.engine === "webmscore" ? "webmscore (browser)" : progress.engine;

  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/70">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
        Browser conversion milestones [{engineLabel}]
      </div>
      <ul className="mt-1 space-y-1 text-[11px]">
        {MILESTONE_ORDER.map((milestone, index) => {
          const status: MilestoneStatus =
            index < activeIndex || progress.milestone === "done"
              ? "done"
              : index === activeIndex
                ? "active"
                : "pending";
          return (
            <li key={milestone} className="flex items-center gap-2">
              <MilestoneDot status={status} />
              <span className="text-slate-600 dark:text-slate-300">
                {MILESTONE_LABELS[milestone]}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">{progress.message}</p>
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        Elapsed: {formatDurationSeconds(elapsedMs)}
      </p>

      {showStaleHint && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          No worker heartbeat for {formatDurationSeconds(heartbeatLagMs)}.
        </p>
      )}

      {(showSlowHint || showStaleHint) && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          If this stays slow, export MusicXML (.mxl or .xml) in MuseScore and upload that directly.
        </p>
      )}
    </div>
  );
}

function MilestoneDot({ status }: { status: MilestoneStatus }) {
  if (status === "done") {
    return <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />;
  }
  if (status === "active") {
    return (
      <span className="relative inline-block h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-600" />
      </span>
    );
  }
  return <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-600" />;
}
