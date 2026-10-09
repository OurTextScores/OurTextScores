"use client";

import { useEffect, useState } from "react";
import CorrectedCopy from "./corrected-copy";
import QuickCopy from "./quick-copy";
import {
  blankCandidate,
  buildCandidateExport,
  placementsFrom,
  proposedSyllables,
  reviewItems,
  setLine,
  setSyllable,
  withDefaults,
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
        if (!res.ok)
          throw new Error(`Lyric candidates unavailable (${res.status})`);
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

  const items = reviewItems(inventory);
  const plan = placementsFrom(items, decisions);
  const update = (
    id: string,
    fn: (d: CandidateDecision) => CandidateDecision,
  ) =>
    setDecisions((prev) => {
      const candidate = items.find((c) => c.id === id)!;
      const next = { ...prev, [id]: fn(withDefaults(prev[id], candidate)) };
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage is a convenience only */
      }
      return next;
    });

  const accepted = items.filter(
    (c) => decisions[c.id]?.state === "accept",
  ).length;

  const download = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          buildCandidateExport(jobId, inventory, decisions),
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lyric-candidates-${jobId}-page-${pageNumber}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (items.length === 0)
    return <p>No lyric regions were detected on this page.</p>;

  return (
    <div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Each row below was read from the scan. Check its text, the note each
        syllable goes to (numbered lines on the picture) and its lyric line,
        then Accept it, or Exclude a row that is not lyrics. Nothing changes
        your score until you press &quot;Add accepted lyrics to the score&quot;.
      </p>
      <QuickCopy
        base={base}
        rasterSha256={inventory.raster.checksumSha256}
        fileStem={`${jobId.slice(0, 8)}-page-${pageNumber}`}
        placements={plan.placements}
        conflicts={plan.conflicts}
        acceptedCount={accepted}
        excludedCount={items.filter((c) => decisions[c.id]?.state === "exclude").length}
        undecidedCount={items.filter((c) => (decisions[c.id]?.state ?? "pending") === "pending").length}
        leftOut={plan.leftOut}
        jobHref={`/scanner/${encodeURIComponent(jobId)}`}
      />
      {items.some(
        (c) =>
          c.proposedLyric === true &&
          (decisions[c.id]?.state ?? "pending") === "pending" &&
          (decisions[c.id]?.text ?? c.initialText).trim() !== "",
      ) && (
        <p className="my-2">
          <button
            type="button"
            className="rounded border border-blue-600 px-3 py-1 text-sm text-blue-700"
            onClick={() =>
              items
                .filter(
                  (c) =>
                    c.proposedLyric === true &&
                    (decisions[c.id]?.state ?? "pending") === "pending" &&
                    (decisions[c.id]?.text ?? c.initialText).trim() !== "",
                )
                .forEach((c) => update(c.id, (x) => setState(x, "accept")))
            }
          >
            Accept all suggested rows
          </button>{" "}
          <span className="text-xs text-slate-500">
            Only rows marked as suggested lyrics; exclude any that are not.
          </span>
        </p>
      )}
      <span data-testid="accepted-count" className="sr-only">
        {accepted} accepted
      </span>
      <p className="my-2 text-sm">
        <a
          className="underline"
          href={`/api/proxy/scanner/jobs/${encodeURIComponent(jobId)}/artifacts/musicxml?page=${pageNumber}&engine=ots-homr`}
        >
          Download recognised score to check note choices
        </a>
      </p>
      <details className="my-4">
        <summary>Full scan for lyric and note context</summary>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${base}/scan`}
          alt="Full recognition scan with lyric and note context"
          className="max-w-full"
        />
      </details>
      <details className="my-4 rounded border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Place syllables by hand (advanced)
        </summary>
        <CorrectedCopy
        base={base}
        rasterSha256={inventory.raster.checksumSha256}
        proposals={proposedSyllables(inventory, decisions)}
        candidates={items
          .filter((c) => decisions[c.id]?.state === "accept")
          .map((c) => ({ id: c.id, text: decisions[c.id].text }))}
      />
      </details>
      <p className="my-2 text-xs text-slate-500">
        <button type="button" onClick={download} className="underline">
          Save my accept/exclude decisions as a file
        </button>{" "}
        (optional; not needed to create the score)
      </p>
      {inventory.ocrStatus === "failed" && (
        <p role="status" className="text-sm text-amber-700">
          Text recognition did not run for this page, so you are seeing detected
          regions without text.
        </p>
      )}
      {items.map((c) => {
        const d = withDefaults(decisions[c.id], c);
        const placeable = c.defaultSyllables.length > 0;
        const withdraw = (fn: (x: typeof d) => typeof d) => update(c.id, fn);
        return (
          <article
            key={c.id}
            className="border-t border-slate-300 py-4 dark:border-slate-700"
          >
            <p className="text-sm">{c.note}</p>
            {c.initialText && (
              <p className="mt-1 text-base">
                <span className="text-xs text-slate-500">Read from the scan: </span>
                <strong>{c.initialText}</strong>
              </p>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${base}/${encodeURIComponent(c.id)}/crop${c.noteChoices.length > 0 ? "?view=placement" : ""}`}
              alt={
                c.noteChoices.length > 0
                  ? "Lyric row with its staff; numbered lines mark the notes you can attach syllables to, blue is the proposal"
                  : "Detected lyric region"
              }
              className="mt-1 max-w-full"
            />
            {placeable ? (
              <div className="mt-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span>Lyric line</span>
                  <select
                    aria-label={`Lyric line for ${d.text}`}
                    value={d.printedLine ?? 1}
                    onChange={(e) =>
                      withdraw((x) => setLine(x, Number(e.target.value)))
                    }
                    className="rounded border px-1"
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-slate-500">
                    (counted from the top under the staff)
                  </span>
                </div>
                <ul className="mt-2 space-y-1">
                  {(d.syllables ?? []).map((syllable, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        aria-label={`Syllable ${i + 1} of ${d.text}`}
                        value={syllable.text}
                        onChange={(e) =>
                          withdraw((x) => setSyllable(x, i, { text: e.target.value }))
                        }
                        className="w-32 rounded border px-1"
                      />
                      <span>→ note</span>
                      <select
                        aria-label={`Note for syllable ${i + 1} of ${d.text}`}
                        value={syllable.noteId ?? ""}
                        onChange={(e) =>
                          withdraw((x) =>
                            setSyllable(x, i, { noteId: e.target.value || null }),
                          )
                        }
                        className="rounded border px-1"
                      >
                        <option value="">Leave out (no note)</option>
                        {c.noteChoices.map((n) => (
                          <option key={n.noteId} value={n.noteId}>
                            {n.number} · {n.pitch} · measure {n.measure}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <label className="mt-2 block text-sm">
                Text{" "}
                <input
                  type="text"
                  value={d.text}
                  onChange={(e) =>
                    update(c.id, (x) => setText(x, e.target.value))
                  }
                  className="w-56 rounded border px-1"
                />
              </label>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40 dark:border-slate-600"
                disabled={d.text.trim() === ""}
                onClick={() => update(c.id, (x) => setState(x, "accept"))}
              >
                Accept
              </button>
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40 dark:border-slate-600"
                onClick={() => update(c.id, (x) => setState(x, "exclude"))}
              >
                Exclude
              </button>
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40 dark:border-slate-600"
                onClick={() => update(c.id, () => blankCandidate(c))}
              >
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
