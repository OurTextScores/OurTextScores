"use client";

import { useCallback, useEffect, useState } from "react";

interface Alternative {
  value: string;
  confidence: number;
}

interface Band {
  start: number;
  end: number;
  basis: "note" | "measure" | "position";
}

interface Spot {
  id: number;
  head: string;
  chosen: string;
  confidence: number;
  alternatives: Alternative[];
  band?: Band | null;
}

interface Review {
  pageNumber: number;
  spots: Spot[];
  remainingFloor: number | null;
  suitability: { symbols: number; spots: number; askableRatio: number; unsuitable: boolean };
}

const HEAD_LABELS: Record<string, string> = {
  pitch: "Which note is this?",
  rhythm: "Which duration is this?",
  lift: "Which accidental is this?",
  articulation: "Which articulation is this?",
  slur: "Is this slurred?",
};

const CLEF_NAMES: Record<string, string> = {
  G2: "treble clef",
  G1: "French violin clef",
  F4: "bass clef",
  F3: "baritone clef",
  F5: "subbass clef",
  C1: "soprano clef",
  C2: "mezzo-soprano clef",
  C3: "alto clef",
  C4: "tenor clef",
  C5: "baritone C clef",
  TAB5: "tablature clef",
};

const SYMBOL_NAMES: Record<string, string> = {
  barline: "a barline",
  doublebarline: "a double barline",
  bolddoublebarline: "a final barline",
  repeatStart: "a repeat start",
  repeatEnd: "a repeat end",
  repeatEndStart: "a repeat end and start",
  voltaStart: "a volta start",
  voltaStop: "a volta end",
  voltaDiscontinue: "a volta break",
  chord: "part of a chord",
  newline: "a line break",
};

/**
 * The `rhythm` head is really "what symbol is this": its vocabulary holds bar
 * lines, clefs, key and time signatures and chord markers alongside note and
 * rest durations. Asking "which duration is this?" over a list containing a
 * clef is incoherent, so the question follows the options rather than the head.
 */
function questionFor(head: string, options: string[]): string {
  if (head === "rhythm") {
    const allDurations = options.every((value) => /^(note|rest)_/.test(value));
    return allDurations ? "Which duration is this?" : "What is this symbol?";
  }
  return HEAD_LABELS[head] || "What is this?";
}

/**
 * HOMR's raw tokens are not reader-facing. `.` means "no note" and `_` means
 * "no decoration", and showing either verbatim asks a reviewer to interpret the
 * model's vocabulary rather than the music.
 *
 * Durations are Humdrum **kern: the number is how many of the note fit in a
 * whole note. A power of two is an ordinary note value; anything else is a
 * tuplet, and `kern_to_symbol_duration` resolves it as `base` notes in the
 * space of `prior_power_of_two(base)`. So `note_48` is 48 in the space of 32 —
 * a triplet thirty-second, not the "1/48 note" a naive reading produces.
 */
const NOTE_VALUE_NAMES: Record<number, string> = {
  1: "whole",
  2: "half",
  4: "quarter",
  8: "eighth",
  16: "sixteenth",
  32: "thirty-second",
  64: "sixty-fourth",
  128: "hundred-twenty-eighth",
};

// Keyed on the *reduced* ratio: kern 12 against 8 and kern 48 against 32 are
// both 3:2, and describing one note's duration only needs the ratio, not the
// grouping it came from.
const TUPLET_NAMES: Record<string, string> = {
  "3:2": "triplet",
  "5:4": "quintuplet",
  "7:4": "septuplet",
  "9:8": "nonuplet",
};

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function priorPowerOfTwo(value: number): number {
  let power = 1;
  while (power * 2 < value) power *= 2;
  return power;
}

export function describeDuration(kern: string): string {
  if (kern.endsWith("m")) return "multi-measure rest";
  const match = kern.match(/^(\d*)(G?)(\.*)$/);
  if (!match) return kern;
  const [, digits, grace, dots] = match;
  const base = digits === "" ? 4 : Number(digits);
  const dotted = dots.length === 1 ? "dotted " : dots.length > 1 ? "double-dotted " : "";
  const gracePrefix = grace ? "grace " : "";

  // kern 0 is the whole-measure rest, not a note value.
  if (base === 0) return `${gracePrefix}whole-measure rest`;

  const isPowerOfTwo = (base & (base - 1)) === 0;
  if (isPowerOfTwo) {
    const name = NOTE_VALUE_NAMES[base] || `1/${base}`;
    return `${gracePrefix}${dotted}${name}`;
  }

  const normal = priorPowerOfTwo(base);
  const name = NOTE_VALUE_NAMES[normal] || `1/${normal}`;
  const divisor = greatestCommonDivisor(base, normal);
  const ratio = `${base / divisor}:${normal / divisor}`;
  const tuplet = TUPLET_NAMES[ratio] || `${ratio}`;
  return `${gracePrefix}${dotted}${tuplet} ${name}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function readable(head: string, value: string): string {
  if (value === "." || value === "_" || value === "") {
    return head === "slur" || head === "articulation" || head === "lift"
      ? "none"
      : "nothing here";
  }
  const rhythm = value.match(/^(note|rest)_(.+)$/);
  if (rhythm) {
    const [, kind, kern] = rhythm;
    return `${describeDuration(kern)} ${kind}`;
  }
  if (value === "slurStart") return "a slur starts here";
  if (value === "slurEnd") return "a slur ends here";
  if (SYMBOL_NAMES[value]) return SYMBOL_NAMES[value];

  const clef = value.match(/^clef_(.+)$/);
  if (clef) return CLEF_NAMES[clef[1]] || "a clef";

  const key = value.match(/^keySignature_(-?\d+)$/);
  if (key) {
    const fifths = Number(key[1]);
    if (fifths === 0) return "no sharps or flats";
    const count = Math.abs(fifths);
    return `${count} ${fifths > 0 ? "sharp" : "flat"}${count === 1 ? "" : "s"}`;
  }

  const time = value.match(/^timeSignature\/(.+)$/);
  if (time) return `a time signature (/${time[1]})`;

  return value;
}

interface Option {
  value: string;
  label: string;
  confidence: number;
  recognised: boolean;
}

/**
 * Collapse options that read the same.
 *
 * HOMR has two placeholders — `.` for "not applicable" and `_` for "no
 * decoration" — and for a pitch they both mean no note. Showing "nothing here"
 * twice asks the reviewer to choose between two things they cannot tell apart.
 *
 * Confidences are summed because the outcomes are mutually exclusive and mean
 * the same thing: the chance the answer is "nothing here" really is the sum.
 * The highest-confidence member is what gets submitted, so the value sent is
 * always one the model actually offered.
 */
export function mergeOptions(options: Option[]): Option[] {
  const byLabel = new Map<string, Option>();
  for (const option of options) {
    const existing = byLabel.get(option.label);
    if (!existing) {
      byLabel.set(option.label, { ...option });
      continue;
    }
    byLabel.set(option.label, {
      label: option.label,
      confidence: existing.confidence + option.confidence,
      value: existing.confidence >= option.confidence ? existing.value : option.value,
      recognised: existing.recognised || option.recognised
    });
  }
  return [...byLabel.values()].sort((left, right) => right.confidence - left.confidence);
}

export default function PageReview({
  jobId,
  pageNumber,
}: {
  jobId: string;
  pageNumber: number;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [position, setPosition] = useState(0);
  const [level, setLevel] = useState<"staff" | "context">("staff");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPosition(0);
    fetch(`/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/review`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) {
          setReview(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, pageNumber]);

  // Reset the zoom when moving on: the previous spot's context says nothing
  // about the next one.
  const advance = useCallback(() => {
    setPosition((current) => current + 1);
    setLevel("staff");
    setError(null);
  }, []);

  // Going back matters because a choice is committed the moment it is clicked:
  // without this, a misclick is only fixable by re-reviewing the whole page.
  const goBack = useCallback(() => {
    setPosition((current) => Math.max(0, current - 1));
    setLevel("staff");
    setError(null);
  }, []);

  const choose = useCallback(
    async (spotId: number, value: string) => {
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/corrections`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ spotId, chosen: value }),
          },
        );
        if (!response.ok) throw new Error("save failed");
        advance();
      } catch {
        // Keep the reviewer on the spot they were working: silently advancing
        // would lose their decision without saying so.
        setError("That could not be saved. Try again, or skip this one.");
      } finally {
        setSaving(false);
      }
    },
    [advance, jobId, pageNumber],
  );

  if (loading) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">Loading review…</p>
    );
  }
  if (!review || review.spots.length === 0) {
    return (
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Nothing on this page looked uncertain.
      </p>
    );
  }

  const spot = review.spots[position];
  const remaining = review.spots.length - position;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Check the uncertain spots
        </h3>
        {spot && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            spot {position + 1} of {review.spots.length}, least certain first
          </span>
        )}
      </div>

      {review.suitability.unsuitable && (
        // Say so rather than presenting hundreds of questions as though the page
        // were nearly right. Never a gate: the queue is still below.
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          The scanner was unsure about {percent(review.suitability.askableRatio)} of this
          page, so it is probably past what automatic recognition can do — handwritten
          or heavily marked scores usually are. You can still work through the list,
          but the Score Editor may be faster.
        </p>
      )}

      {!spot ? (
        <div className="text-sm text-slate-600 dark:text-slate-400">
          <p>
            {position >= review.spots.length
              ? "That is everything flagged on this page."
              : "Stopped here. The rest are listed above if you want them."}
          </p>
          {position > 0 && (
            <button
              type="button"
              onClick={goBack}
              className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Back to the last one
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/crop/${spot.id}?level=${level}`}
              alt={`Page ${pageNumber}, the passage the scanner was unsure about`}
              className="max-h-80 w-full object-contain"
            />
            {/* Without this the question is unanswerable: a staff crop can hold
                thirty notes, and "which duration is this?" needs to say which.
                Drawn at both levels: the context crop grows only vertically, so
                the band's horizontal position stays correct. */}
            {spot.band && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 border-x-2 border-cyan-500 bg-cyan-400/20"
                style={{
                  left: `${spot.band.start * 100}%`,
                  width: `${Math.max(2, (spot.band.end - spot.band.start) * 100)}%`,
                }}
              />
            )}
          </div>
          {spot.band && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {spot.band.basis === "note"
                ? "Highlighted: this symbol."
                : spot.band.basis === "measure"
                  ? "Highlighted: the measure it is in — the exact position was unreliable here."
                  : "Highlighted: roughly where it falls."}
            </p>
          )}
          <div className="mt-2 flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => setLevel(level === "staff" ? "context" : "staff")}
              className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              {level === "staff" ? "Show the staves around it" : "Back to this staff"}
            </button>
          </div>

          <p className="mt-4 text-sm font-medium text-slate-900 dark:text-slate-100">
            {questionFor(spot.head, [
              spot.chosen,
              ...spot.alternatives.map((alternative) => alternative.value),
            ])}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {mergeOptions([
              {
                value: spot.chosen,
                label: readable(spot.head, spot.chosen),
                confidence: spot.confidence,
                recognised: true,
              },
              ...spot.alternatives.map((alternative) => ({
                value: alternative.value,
                label: readable(spot.head, alternative.value),
                confidence: alternative.confidence,
                recognised: false,
              })),
            ]).map((option) => (
              <li key={option.label}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void choose(spot.id, option.value)}
                  className="flex w-full items-center gap-2 rounded border border-slate-200 px-3 py-2 text-left hover:border-cyan-400 hover:bg-cyan-50 disabled:opacity-50 dark:border-slate-800 dark:hover:border-cyan-700 dark:hover:bg-cyan-950/40"
                >
                  <span className="text-slate-900 dark:text-slate-100">{option.label}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {percent(option.confidence)}
                    {option.recognised ? " — what the scanner chose" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{error}</p>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {/* The number that makes stopping a judgement rather than fatigue:
                it rises as the queue is worked. */}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {remaining - 1 > 0
                ? `${remaining - 1} more after this, all at least ${percent(
                    review.spots[position + 1]?.confidence ?? spot.confidence,
                  )} confident`
                : "This is the last one flagged."}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={goBack}
                disabled={saving || position === 0}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={advance}
                disabled={saving}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => setPosition(review.spots.length)}
                disabled={saving}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                Skip remaining
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
