"use client";

import { useEffect, useState } from "react";
import {
  blankCandidate,
  buildCandidateExport,
  setState,
  setText,
  type CandidateDecision,
  type Inventory,
} from "./candidate-review-model";

function load(key: string): Record<string, CandidateDecision> {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
}

export default function LyricCandidatesClient({
  jobId,
  pageNumber,
}: {
  jobId: string;
  pageNumber: number;
}) {
  const base = `/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}/pages/${pageNumber}/lyric-candidates`;
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [decisions, setDecisions] = useState<Record<string, CandidateDecision>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(base, { cache: "no-store" });
        if (!res.ok) throw new Error(`Lyric candidates unavailable (${res.status})`);
        const body = (await res.json()) as Inventory;
        if (cancelled) return;
        const k = `ots-lyric-candidates-${jobId}-${pageNumber}-${body.raster.checksumSha256}`;
        setInventory(body);
        setKey(k);
        setDecisions(load(k));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, jobId, pageNumber]);

  if (error) return <p role="alert">{error}</p>;
  if (!inventory) return <p>Loading lyric candidates…</p>;

  const update = (id: string, fn: (d: CandidateDecision) => CandidateDecision) =>
    setDecisions((prev) => {
      const candidate = inventory.candidates.find((c) => c.id === id)!;
      const next = { ...prev, [id]: fn(prev[id] ?? blankCandidate(candidate)) };
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage is a convenience only */
      }
      return next;
    });

  const accepted = inventory.candidates.filter(
    (c) => decisions[c.id]?.state === "accept",
  ).length;

  const download = () => {
    const blob = new Blob(
      [JSON.stringify(buildCandidateExport(jobId, inventory, decisions), null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lyric-candidates-${jobId}-page-${pageNumber}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (inventory.candidates.length === 0)
    return <p>No lyric regions were detected on this page.</p>;

  return (
    <div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        The detector found these regions that may hold lyrics. Type what is
        printed in each crop, then accept it, or exclude a region that is not
        lyrics. Nothing here changes your score.
      </p>
      <div className="my-4 flex items-center gap-4">
        <button
          type="button"
          onClick={download}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white"
        >
          Export decisions
        </button>
        <span data-testid="accepted-count">{accepted} accepted</span>
      </div>
      {inventory.candidates.map((c) => {
        const d = decisions[c.id] ?? blankCandidate(c);
        return (
          <article
            key={c.id}
            className="border-t border-slate-300 py-4 dark:border-slate-700"
          >
            <p className="text-sm">
              {c.regionStatus === "review"
                ? `Needs review (${c.reason})`
                : "Detected"}
              {c.competingText ? " — may be a direction or dynamic" : ""}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${base}/${encodeURIComponent(c.id)}/crop`}
              alt="Detected lyric region"
              className="max-h-[260px] max-w-full"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <label>
                Text{" "}
                <input
                  type="text"
                  value={d.text}
                  onChange={(e) => update(c.id, (x) => setText(x, e.target.value))}
                  className="w-56 rounded border px-1"
                />
              </label>
              <button
                type="button"
                disabled={d.text.trim() === ""}
                onClick={() => update(c.id, (x) => setState(x, "accept"))}
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => update(c.id, (x) => setState(x, "exclude"))}
              >
                Exclude
              </button>
              <button type="button" onClick={() => update(c.id, () => blankCandidate(c))}>
                Reset
              </button>
              <span data-testid={`state-${c.id}`}>{d.state}</span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
