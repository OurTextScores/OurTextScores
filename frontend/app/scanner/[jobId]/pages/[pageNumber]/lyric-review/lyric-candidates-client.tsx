"use client";

import { useEffect, useState } from "react";
import CorrectedCopy from "./corrected-copy";
import QuickCopy from "./quick-copy";
import DirectionsReview from "./directions-review";
import {
  directionItems,
  directionPlan,
  blankDirection,
  type DirectionDecision,
} from "./direction-review-model";
import {
  blankCandidate,
  buildCandidateExport,
  placementsFrom,
  proposedSyllables,
  reviewItems,
  setLine,
  setSlot,
  slotsElsewhere,
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
  const [directionDecisions, setDirectionDecisions] = useState<Record<string, DirectionDecision>>({});
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
        setDirectionDecisions(
          load(`${k}-directions`) as unknown as Record<string, DirectionDecision>,
        );
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

  const directionList = directionItems(inventory);
  const directionOutcome = directionPlan(directionList, directionDecisions);
  const updateDirection = (id: string, next: DirectionDecision) =>
    setDirectionDecisions((prev) => {
      const merged = { ...prev, [id]: next };
      try {
        window.localStorage.setItem(`${key}-directions`, JSON.stringify(merged));
      } catch {
        /* storage is a convenience only */
      }
      return merged;
    });

  // Directions and dynamics that can be accepted in one go: undecided, with a note and text already proposed.
  const suggestedDirections = directionList.filter((item) => {
    const d = directionDecisions[item.id] ?? blankDirection(item);
    return (
      d.state === "pending" &&
      d.noteId !== null &&
      (item.kind === "dynamic" ? d.mark : d.text).trim() !== ""
    );
  });

  const directionCount = (state: "accept" | "exclude" | "pending") =>
    directionList.filter((item) => (directionDecisions[item.id]?.state ?? "pending") === state).length;

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

  if (items.length === 0 && directionList.length === 0)
    return <p>No lyric regions were detected on this page.</p>;

  return (
    <div>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Each row below was read from the scan: lyrics, then written directions
        and dynamic marks (staff text). Check its text, the note it goes to
        (numbered lines on the picture) and, for lyrics, its lyric line, then
        Accept it, or Exclude a row that is not one. Nothing changes your
        score until you press &quot;Add accepted lyrics and staff text to the
        score&quot;.
      </p>
      <QuickCopy
        base={base}
        rasterSha256={inventory.raster.checksumSha256}
        fileStem={`${jobId.slice(0, 8)}-page-${pageNumber}`}
        placements={plan.placements}
        conflicts={plan.conflicts}
        acceptedCount={accepted + directionCount("accept")}
        excludedCount={items.filter((c) => decisions[c.id]?.state === "exclude").length + directionCount("exclude")}
        undecidedCount={items.filter((c) => (decisions[c.id]?.state ?? "pending") === "pending").length + directionCount("pending")}
        leftOut={[...plan.leftOut, ...directionOutcome.leftOut]}
        directions={directionOutcome.directions}
        directionConflicts={directionOutcome.conflicts}
        acceptedDirections={directionOutcome.directions.length}
        jobHref={`/scanner/${encodeURIComponent(jobId)}`}
      />
      {(items.some(
        (c) =>
          c.proposedLyric === true &&
          (decisions[c.id]?.state ?? "pending") === "pending" &&
          (decisions[c.id]?.text ?? c.initialText).trim() !== "",
      ) || suggestedDirections.length > 0) && (
        <p className="my-2">
          <button
            type="button"
            className="rounded border border-blue-600 px-3 py-1 text-sm text-blue-700"
            onClick={() => {
              items
                .filter(
                  (c) =>
                    c.proposedLyric === true &&
                    (decisions[c.id]?.state ?? "pending") === "pending" &&
                    (decisions[c.id]?.text ?? c.initialText).trim() !== "",
                )
                .forEach((c) => update(c.id, (x) => setState(x, "accept")));
              suggestedDirections.forEach((item) =>
                updateDirection(item.id, {
                  ...(directionDecisions[item.id] ?? blankDirection(item)),
                  state: "accept",
                }),
              );
            }}
          >
            Accept all suggested rows
          </button>{" "}
          <span className="text-xs text-slate-500">
            Covers the lyrics the scanner suggests plus directions and dynamics
            that already have a proposed note; exclude any that are not right.
            Rows with no proposed note stay for you to place.
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
      {items.length > 0 && <h2 className="mt-8 text-lg font-semibold">Lyrics</h2>}
      {items.map((c) => {
        const d = withDefaults(decisions[c.id], c);
        const placeable = c.defaultSyllables.length > 0 && c.noteChoices.length > 0;
        const elsewhere = placeable ? slotsElsewhere(items, decisions, c.id, d.printedLine ?? 1) : {};
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
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                  Type the syllable that belongs under each notehead (the numbers match the picture). Blank
                  means no syllable on that note. To split a word, put its parts on neighbouring notes.
                </p>
                <ol className="mt-1 flex flex-wrap gap-2">
                  {c.noteChoices.map((n) => {
                    const value = d.slots?.[n.noteId] ?? "";
                    const other = !value.trim() ? elsewhere[n.noteId] : undefined;
                    if (other)
                      return (
                        <li key={n.noteId} className="w-24">
                          <label
                            className="block text-[11px] text-slate-500"
                            title={`This note's lyric is in the review pane for "${other.rowText}"; edit it there.`}
                          >
                            <span className="mr-1 inline-block h-4 w-4 rounded-full border border-slate-300 text-center text-[10px] leading-4">
                              {n.number}
                            </span>
                            {n.pitch} · m{n.measure}
                            <input
                              type="text"
                              readOnly
                              aria-label={`Text for note ${n.number} of ${d.text} (in another review pane)`}
                              value={other.text}
                              className="mt-0.5 block w-full rounded border border-slate-200 bg-slate-100 px-1 text-sm italic text-slate-500 dark:bg-slate-800"
                            />
                            <span className="text-[10px]">in another review pane</span>
                          </label>
                        </li>
                      );
                    return (
                      <li key={n.noteId} className="w-24">
                        <label className="block text-[11px] text-slate-600 dark:text-slate-400">
                          <span
                            className={`mr-1 inline-block h-4 w-4 rounded-full text-center text-[10px] font-bold leading-4 ${
                              value.trim()
                                ? "bg-blue-600 text-white"
                                : "border border-slate-400"
                            }`}
                          >
                            {n.number}
                          </span>
                          {n.pitch} · m{n.measure}
                          <input
                            type="text"
                            aria-label={`Text for note ${n.number} of ${d.text}`}
                            value={value}
                            onChange={(e) =>
                              withdraw((x) => setSlot(x, n.noteId, e.target.value))
                            }
                            className={`mt-0.5 block w-full rounded border px-1 text-sm ${
                              value.trim() ? "border-blue-500" : "border-dashed"
                            }`}
                          />
                        </label>
                      </li>
                    );
                  })}
                </ol>
                {(d.unplaced ?? []).length > 0 && (
                  <p className="mt-1 text-xs text-amber-800">
                    Not placed (no note of its own): {(d.unplaced ?? []).join(", ")}. Type it under a note
                    to place it.
                  </p>
                )}
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
      <DirectionsReview
        base={base}
        items={directionList}
        decisions={directionDecisions}
        onChange={updateDirection}
      />
    </div>
  );
}
