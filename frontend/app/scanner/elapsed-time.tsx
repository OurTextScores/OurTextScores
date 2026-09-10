"use client";

import { useEffect, useState } from "react";

/**
 * How long something has been going, as a reader would say it.
 *
 * Under an hour this is `m:ss`, because that is the range a scan almost always
 * finishes in and a leading `0:` for the hour would be noise on every page.
 * Past it the hours appear rather than the minutes rolling on past sixty,
 * which is the point at which a reader stops counting and starts asking
 * whether anything is happening at all.
 */
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * A clock that counts up from `since`, ticking once a second.
 *
 * The scanner's active states used to be bare words -- "Recognizing…",
 * "Waiting" -- which say what is happening but not whether it is stuck. Four
 * seconds and four minutes read identically, so a reader with no way to tell
 * them apart reloads the page to find out.
 *
 * It starts null and fills in on mount: the server has no idea what time it is
 * on the reader's machine, so rendering an elapsed time during SSR would
 * hydrate into a mismatch, and a wrong first frame is worse than a late one.
 */
export function ElapsedTime({
  since,
  className,
}: {
  /** ISO-8601, from the job or engine run that started the work. */
  since?: string;
  className?: string;
}) {
  const startedAt = since ? Date.parse(since) : Number.NaN;
  const valid = Number.isFinite(startedAt);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!valid) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [valid, startedAt]);

  if (!valid || now === null) return null;
  const elapsed = formatElapsed(now - startedAt);
  return (
    <time
      dateTime={new Date(startedAt).toISOString()}
      data-testid="elapsed-time"
      className={className ?? "tabular-nums text-slate-500"}
      // The number changes every second. Announcing each one would talk over
      // everything else on the page, and the label beside it already said what
      // is happening.
      aria-hidden="true"
    >
      {elapsed}
    </time>
  );
}
