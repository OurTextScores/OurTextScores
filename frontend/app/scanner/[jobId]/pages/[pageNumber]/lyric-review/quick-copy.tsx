"use client";

import { useEffect, useState } from "react";
import type { Placement } from "./candidate-review-model";
import type { DirectionPayload } from "./direction-review-model";

type NoteChoice = { id: string; measureLabel: string; noteOrdinal: number; pitch: string };

/**
 * The last step: the syllables on the accepted rows, each already decided in its card (text, note, lyric
 * line), are added to the scan's score. "Accept" on a row is the reviewer's check that the text, the lyric
 * line and the chosen notes it shows are right; this panel lists exactly what will be written and asks for one
 * confirmation. The copy writer still receives every confirmation explicitly and refuses anything stale or
 * conflicting.
 */
export default function QuickCopy({
  base,
  rasterSha256,
  fileStem,
  placements,
  conflicts,
  leftOut,
  acceptedCount,
  excludedCount,
  undecidedCount,
  directions = [],
  directionConflicts = [],
  acceptedDirections = 0,
  jobHref,
}: {
  base: string;
  rasterSha256: string;
  fileStem: string;
  placements: Placement[];
  conflicts: string[];
  leftOut: string[];
  acceptedCount: number;
  excludedCount: number;
  undecidedCount: number;
  directions?: DirectionPayload[];
  directionConflicts?: string[];
  acceptedDirections?: number;
  jobHref: string;
}) {
  const [notes, setNotes] = useState<Record<string, NoteChoice>>({});
  const [sha, setSha] = useState("");
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`${base}/notes`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Recognised note choices unavailable (${response.status})`);
        const body = await response.json();
        if (cancelled) return;
        setSha(body.musicXmlSha256);
        setNotes(Object.fromEntries(body.notes.map((n: NoteChoice) => [n.id, n])));
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [base]);

  // Any change to what would be written starts a fresh review.
  const signature =
    placements.map((p) => `${p.candidateId}|${p.noteId}|${p.printedLine}|${p.text}`).join("\n") +
    "\n--\n" +
    directions.map((d) => `${d.candidateId}|${d.noteId}|${d.kind}|${d.text}|${d.placement}`).join("\n");
  useEffect(() => {
    setChecked(false);
    setSaved("");
  }, [signature]);

  const request = async (path: string) => {
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        automaticAttachment: false,
        rasterSha256,
        musicXmlSha256: sha,
        directions: directions.map((d, i) => ({
          id: `direction-${i}`,
          ...d,
          textConfirmed: true,
          noteConfirmed: true,
        })),
        placements: placements.map((p, i) => ({
          id: `review-${i}`,
          candidateId: p.candidateId,
          text: p.text,
          noteId: p.noteId,
          printedLine: p.printedLine,
          textConfirmed: true,
          lineConfirmed: true,
          noteConfirmed: true,
        })),
      }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      throw new Error(failure?.message ?? `The score update was refused (${response.status})`);
    }
    return response;
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveToScore = () =>
    run(async () => {
      await request("save-lyrics");
      setSaved(
        `Added ${placements.length} lyric syllables${directions.length ? ` and ${directions.length} directions or dynamics` : ""} to the scan's score.`,
      );
    });

  const downloadCopy = () =>
    run(async () => {
      const response = await request("corrected-copy");
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileStem}-with-lyrics.musicxml`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

  const ready =
    Boolean(sha) &&
    placements.length + directions.length > 0 &&
    conflicts.length === 0 &&
    directionConflicts.length === 0;
  return (
    <section className="my-4 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-slate-900">
      <p className="text-sm font-medium" data-testid="review-summary">
        {acceptedCount} accepted · {excludedCount} excluded · {undecidedCount} not decided yet
      </p>
      {conflicts.length > 0 && (
        <p role="alert" className="mt-2 text-sm text-amber-800">
          Two syllables share a note and lyric line ({conflicts.join("; ")}). A note holds one syllable per
          line: change one note, or leave it out.
        </p>
      )}
      {directionConflicts.length > 0 && (
        <p role="alert" className="mt-2 text-sm text-amber-800">
          {directionConflicts.join("; ")}. Exclude one or choose another note.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved ? (
        <div className="mt-3" role="status">
          <p className="text-sm text-green-800">{saved}</p>
          <a
            href={jobHref}
            className="mt-2 inline-block rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          >
            View the score with lyrics
          </a>
          <p className="mt-2 text-xs text-slate-600">
            The preview and combined score rebuild in the background. Changing notes on this page later
            regenerates its score and drops the lyrics, so correct notes first and then review lyrics.
          </p>
        </div>
      ) : !open ? (
        <div className="mt-3">
          <button
            type="button"
            disabled={!ready}
            onClick={() => setOpen(true)}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Add accepted lyrics to the score
          </button>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            {placements.length + directions.length > 0
              ? `${placements.length} syllables${directions.length ? ` and ${directions.length} directions or dynamics` : ""} with a chosen note will be added.`
              : acceptedCount + acceptedDirections > 0
                ? "None of the accepted rows has a note chosen."
                : "Accept the rows that are lyrics (check their notes and lyric line), then add them to the score."}
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm">
            These syllables will be added to this page&apos;s score. Rows you excluded or left undecided add
            nothing.
          </p>
          <ol className="mt-2 max-h-72 list-decimal overflow-auto pl-6 text-sm">
            {placements.map((p, i) => {
              const note = notes[p.noteId];
              return (
                <li key={`${p.candidateId}-${p.noteId}-${p.printedLine}-${i}`}>
                  <strong>{p.text}</strong>
                  {note
                    ? ` → measure ${note.measureLabel}, ${note.pitch} (note ${note.noteOrdinal}), lyric line ${p.printedLine}`
                    : ` → lyric line ${p.printedLine}`}
                </li>
              );
            })}
          </ol>
          {directions.length > 0 && (
            <ol className="mt-2 max-h-48 list-decimal overflow-auto pl-6 text-sm" aria-label="Directions to add">
              {directions.map((d, i) => {
                const note = notes[d.noteId];
                return (
                  <li key={`${d.candidateId}-${d.noteId}-${i}`}>
                    <strong>{d.text}</strong>
                    {` (${d.kind === "dynamic" ? "dynamic" : "direction"}, ${d.placement})`}
                    {note ? ` → measure ${note.measureLabel}, ${note.pitch} (note ${note.noteOrdinal})` : ""}
                  </li>
                );
              })}
            </ol>
          )}
          {leftOut.length > 0 && (
            <p className="mt-2 text-xs text-amber-800">
              Left out (no note chosen): {leftOut.join(", ")}.
            </p>
          )}
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1"
            />
            I checked these syllables, their lyric lines and their notes against the scan.
          </label>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={!checked || busy}
              onClick={saveToScore}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy ? "Working…" : "Add lyrics to the score"}
            </button>
            <button
              type="button"
              disabled={!checked || busy}
              onClick={downloadCopy}
              className="rounded border px-3 py-2 text-sm disabled:opacity-40"
            >
              Download a copy instead
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded border px-3 py-2 text-sm">
              Back
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
