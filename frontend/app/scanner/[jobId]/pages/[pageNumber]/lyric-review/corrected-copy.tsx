"use client";

import { useEffect, useState } from "react";

type Note = {
  id: string;
  partId: string;
  partName?: string;
  measure: number;
  measureLabel: string;
  noteOrdinal: number;
  onsetQuarterNotes: number;
  pitch: string;
  voice: string;
  staff: string;
  occupiedLines: string[];
};
type Placement = {
  id: string;
  candidateId: string;
  text: string;
  noteId: string;
  printedLine: number;
  textConfirmed: boolean;
  lineConfirmed: boolean;
  noteConfirmed: boolean;
};

/** Kept separate from text acceptance: row acceptance never confirms a note. */
export default function CorrectedCopy({
  base,
  rasterSha256,
  candidates,
}: {
  base: string;
  rasterSha256: string;
  candidates: { id: string; text: string }[];
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [sha, setSha] = useState("");
  const [rows, setRows] = useState<Placement[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageKey, setStorageKey] = useState("");
  useEffect(() => {
    let cancelled = false;
    setStorageKey("");
    setRows([]);
    setNotes([]);
    setSha("");
    setError("");
    fetch(`${base}/notes`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Recognised note choices unavailable (${response.status})`,
          );
        const body = await response.json();
        if (!cancelled) {
          setNotes(body.notes);
          setSha(body.musicXmlSha256);
          const key = `ots-reviewed-syllables-${base}-${rasterSha256}-${body.musicXmlSha256}`;
          try {
            const saved = JSON.parse(window.localStorage.getItem(key) ?? "[]");
            if (
              Array.isArray(saved) &&
              saved.every(
                (r) =>
                  typeof r.id === "string" &&
                  typeof r.candidateId === "string" &&
                  typeof r.text === "string" &&
                  typeof r.noteId === "string" &&
                  Number.isInteger(r.printedLine) &&
                  [r.textConfirmed, r.lineConfirmed, r.noteConfirmed].every(
                    (v) => typeof v === "boolean",
                  ),
              )
            )
              setRows(saved);
          } catch {
            /* drafts are only a convenience */
          }
          setStorageKey(key);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base, rasterSha256]);
  useEffect(() => {
    if (storageKey)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(rows));
      } catch {
        /* drafts are only a convenience */
      }
  }, [storageKey, rows]);
  const payload = () => ({
    automaticAttachment: false,
    rasterSha256,
    musicXmlSha256: sha,
    placements: rows,
  });
  const exportPlan = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload(), null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "reviewed-syllable-placements.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const update = (index: number, patch: Partial<Placement>) =>
    setRows((previous) =>
      previous.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  const valid =
    rows.length > 0 &&
    rows.every(
      (r) =>
        candidates.some((c) => c.id === r.candidateId) &&
        r.text.trim() &&
        r.noteId &&
        r.textConfirmed &&
        r.lineConfirmed &&
        r.noteConfirmed,
    );
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${base}/corrected-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automaticAttachment: false,
          rasterSha256,
          musicXmlSha256: sha,
          placements: rows,
        }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(
          failure?.message ?? `Copy refused (${response.status})`,
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "reviewed-lyrics.musicxml";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="my-6 rounded border p-4">
      <h2 className="font-semibold">
        Create a score copy with reviewed syllables
      </h2>
      <p className="my-2 text-sm">
        Add one syllable at a time from an accepted region below. Select its
        recognised note and the printed lyric line counted from top to bottom.
        Confirm all three against the scan. The original score stays unchanged.
        Only listed syllables are added; hyphenation and melismas need later
        editing.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={!sha || !candidates.length}
        onClick={() =>
          setRows((r) => [
            ...r,
            {
              id: `syllable-${r.length}-${Date.now()}`,
              candidateId: candidates[0].id,
              text: "",
              noteId: "",
              printedLine: 1,
              textConfirmed: false,
              lineConfirmed: false,
              noteConfirmed: false,
            },
          ])
        }
        className="rounded border px-2 py-1 disabled:opacity-40"
      >
        Add reviewed syllable
      </button>
      {rows.map((row, i) => (
        <fieldset key={row.id} className="my-3 border p-3">
          <legend>Syllable {i + 1}</legend>
          <label className="block">
            Accepted scan region{" "}
            <select
              value={row.candidateId}
              onChange={(e) =>
                update(i, {
                  candidateId: e.target.value,
                  textConfirmed: false,
                  noteConfirmed: false,
                  lineConfirmed: false,
                })
              }
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.text}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Correct syllable{" "}
            <input
              value={row.text}
              maxLength={200}
              onChange={(e) =>
                update(i, { text: e.target.value, textConfirmed: false })
              }
              className="m-1 border"
            />
          </label>
          <label className="block">
            Recognised note{" "}
            <select
              value={row.noteId}
              onChange={(e) =>
                update(i, { noteId: e.target.value, noteConfirmed: false })
              }
            >
              <option value="">Choose the note</option>
              {notes.map((note) => (
                <option key={note.id} value={note.id}>
                  Part {note.partName || note.partId}, measure{" "}
                  {note.measureLabel} (physical {note.measure}), +
                  {Number(note.onsetQuarterNotes.toFixed(3))} quarter notes,{" "}
                  {note.pitch} (note {note.noteOrdinal}), staff {note.staff},
                  voice {note.voice || "1"}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Printed lyric line{" "}
            <input
              type="number"
              min={1}
              max={20}
              value={row.printedLine}
              onChange={(e) =>
                update(i, {
                  printedLine: Number(e.target.value),
                  lineConfirmed: false,
                })
              }
              className="m-1 w-16 border"
            />
          </label>
          {(["textConfirmed", "lineConfirmed", "noteConfirmed"] as const).map(
            (key) => (
              <label key={key} className="mr-3 inline-block">
                <input
                  type="checkbox"
                  checked={row[key]}
                  onChange={(e) => update(i, { [key]: e.target.checked })}
                />{" "}
                {key === "textConfirmed"
                  ? "Syllable text confirmed"
                  : key === "lineConfirmed"
                    ? "Printed line confirmed"
                    : "Note placement confirmed"}
              </label>
            ),
          )}
          <button
            type="button"
            onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
          >
            Remove syllable {i + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={!valid || busy}
        onClick={download}
        className="mt-2 rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-40"
      >
        {busy ? "Validating…" : "Download corrected score copy"}
      </button>
      <button
        type="button"
        disabled={!valid || busy}
        onClick={exportPlan}
        className="ml-3 rounded border px-3 py-1 disabled:opacity-40"
      >
        Export confirmed placement plan
      </button>
    </section>
  );
}
