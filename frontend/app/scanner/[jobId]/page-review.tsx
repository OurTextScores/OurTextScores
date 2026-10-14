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
  /** The staff's own slice of the context crop, which also holds its neighbours. */
  contextTop?: number;
  contextHeight?: number;
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
  position?: number;
  readOnly?: boolean;
  pageNumber: number;
  engineId: string;
  reviewGroup?: string;
  contentSignature: string;
  structuredOutputPending?: boolean;
  spots: Spot[];
  remainingFloor: number | null;
  suitability: {
    symbols: number;
    spots: number;
    askableRatio: number;
    unsuitable: boolean;
  };
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
  PAD: "scanner padding (not a score symbol)",
  BOS: "start of the staff",
  EOS: "end of the staff",
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

const ACCIDENTAL_NAMES: Record<string, string> = {
  "#": "sharp",
  "##": "double sharp",
  N: "natural",
  b: "flat",
  bb: "double flat",
};

const ARTICULATION_NAMES: Record<string, string> = {
  accent: "accent",
  arpeggiate: "arpeggio",
  breathMark: "breath mark",
  fermata: "fermata",
  staccatissimo: "staccatissimo",
  staccato: "staccato",
  tenuto: "tenuto",
  tremolo: "tremolo",
  trill: "trill",
  turn: "turn",
};

const BEAM_STATE_NAMES: Record<string, string> = {
  none: "no beam at this level",
  not_applicable: "this note has no beam at this level",
  flag: "an unjoined flag (no beam)",
  begin: "start a beam",
  continue: "continue the beam",
  end: "end the beam",
  forward_hook: "a forward beam hook",
  backward_hook: "a backward beam hook",
};

const TIE_STATE_NAMES: Record<string, string> = {
  none: "not tied",
  start: "a tie starts here",
  stop: "a tie ends here",
  start_and_stop: "one tie ends and another starts here",
};

const SLUR_EVENT_NAMES: Record<string, string> = {
  none: "no slur event",
  start: "a slur starts here",
  stop: "a slur ends here",
  start_and_stop: "one slur ends and another starts here",
  continue: "the slur continues here",
};

const SLUR_SIDE_NAMES: Record<string, string> = {
  unspecified: "automatic placement (no side specified)",
  above: "above the note",
  below: "below the note",
};

/**
 * The `rhythm` head is really "what symbol is this": its vocabulary holds bar
 * lines, clefs, key and time signatures and chord markers alongside note and
 * rest durations. Asking "which duration is this?" over a list containing a
 * clef is incoherent, so the question follows the options rather than the head.
 */
function questionFor(head: string, options: string[]): string {
  if (head.startsWith("beam.level.")) {
    return `How should beam level ${head.split(".").pop()} continue here?`;
  }
  if (head === "advance.delta") return "When should the next note begin?";
  if (head === "stem.direction") return "Which way should this stem point?";
  if (head === "tie.state") return "How is this note tied?";
  if (head.startsWith("slur.slot.") && head.endsWith(".event"))
    return "What happens to the slur here?";
  if (head.startsWith("slur.slot.") && head.endsWith(".side"))
    return "Which side of the note should the slur use?";
  if (head === "rhythm") {
    const allDurations = options.every((value) => /^(note|rest)_/.test(value));
    if (allDurations) return "Which duration is this?";
    if (options.every((value) => /^timeSignatureBeats_\d+$/.test(value)))
      return "What is the top number of the time signature?";
    if (options.every((value) => /^timeSignature\/.+$/.test(value)))
      return "What is the bottom number of the time signature?";
    if (options.every((value) => /^keySignature_-?\d+$/.test(value)))
      return "Which key signature is this?";
    if (options.every((value) => /^clef_.+$/.test(value)))
      return "Which clef is this?";
    return "What is this symbol?";
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
  const multiMeasure = kern.match(/^(\d+)m$/);
  if (multiMeasure) {
    const measures = Number(multiMeasure[1]);
    return `${measures}-measure`;
  }
  const match = kern.match(/^(\d*)(G?)(\.*)$/);
  if (!match) return kern;
  const [, digits, grace, dots] = match;
  const base = digits === "" ? 4 : Number(digits);
  const dotted =
    dots.length === 1 ? "dotted " : dots.length > 1 ? "double-dotted " : "";
  const gracePrefix = grace ? "grace " : "";

  // HOMR renders kern 0 as a whole note; rest_0 receives the more specific
  // whole-measure wording below, where the symbol kind is known.
  if (base === 0) return `${gracePrefix}whole`;

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

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function readable(head: string, value: string): string {
  if (value === "." || value === "_" || value === "") {
    return head === "slur" || head === "articulation" || head === "lift"
      ? "none"
      : "nothing here";
  }
  const rhythm = value.match(/^(note|rest)_(.+)$/);
  if (rhythm) {
    const [, kind, kern] = rhythm;
    if (kind === "rest" && kern === "0") return "whole-measure rest";
    return `${describeDuration(kern)} ${kind}`;
  }
  if (value === "slurStart") return "a slur starts here";
  if (value === "slurStop" || value === "slurEnd") return "a slur ends here";
  if (value === "slurStart_slurStop")
    return "one slur ends and another starts here";
  if (head.startsWith("beam.level.")) {
    return BEAM_STATE_NAMES[value] || humanizeIdentifier(value);
  }
  if (head === "advance.delta") {
    return value === "not_applicable"
      ? "no following note onset to time"
      : value === "zero"
        ? "at the same time"
        : value === "other"
          ? "after an irregular or tuplet-derived gap"
          : `after ${describeDuration(value)}`;
  }
  if (head === "stem.direction") {
    if (value === "not_applicable")
      return "not a stem-bearing note (for example, a rest)";
    if (value === "none") return "stemless note (for example, a whole note)";
    if (value === "up") return "upward stem";
    if (value === "down") return "downward stem";
    if (value === "double") return "stems in both directions";
  }
  if (head === "tie.state")
    return TIE_STATE_NAMES[value] || humanizeIdentifier(value);
  if (head.startsWith("slur.slot.") && head.endsWith(".event"))
    return SLUR_EVENT_NAMES[value] || humanizeIdentifier(value);
  if (head.startsWith("slur.slot.") && head.endsWith(".side"))
    return SLUR_SIDE_NAMES[value] || humanizeIdentifier(value);
  if (SYMBOL_NAMES[value]) return SYMBOL_NAMES[value];

  if (head === "lift" && ACCIDENTAL_NAMES[value])
    return ACCIDENTAL_NAMES[value];

  if (head === "articulation") {
    return value
      .split("_")
      .map((part) => ARTICULATION_NAMES[part] || humanizeIdentifier(part))
      .join(" + ");
  }

  // Pitch and octave are already standard score-reader notation. Preserve the
  // capital note name rather than sending it through the lowercase fallback.
  if (head === "pitch" && /^[A-G]\d+$/.test(value)) return value;

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
  if (time) return `${time[1]} as the bottom number (beat-note value)`;

  const timeBeats = value.match(/^timeSignatureBeats_(\d+)$/);
  if (timeBeats) return `${timeBeats[1]} as the top number (beats per measure)`;

  // New model values should still be legible before a bespoke musical label is
  // added. In particular, never expose camelCase/snake_case implementation
  // identifiers directly to a reviewer.
  return humanizeIdentifier(value);
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
      value:
        existing.confidence >= option.confidence
          ? existing.value
          : option.value,
      recognised: existing.recognised || option.recognised,
    });
  }
  return [...byLabel.values()].sort(
    (left, right) => right.confidence - left.confidence,
  );
}

const REVIEW_GROUP_LABELS: Record<string, string> = {
  base: "Base recognition",
  beam: "Beams",
  advance: "Rhythmic spacing",
  stem: "Stem direction",
  tie: "Ties",
  slur: "Slurs",
};

export default function PageReview({
  jobId,
  pageNumber,
  engineId,
  engineLabel,
  reviewGroup = "base",
  onStructuredFamilyDecision,
  onProgress,
  onBusyChange,
}: {
  jobId: string;
  pageNumber: number;
  engineId?: string;
  engineLabel?: string;
  reviewGroup?: string;
  onProgress?: (position: number, contentSignature: string) => Promise<void>;
  onBusyChange?: (engineId: string, busy: boolean) => void;
  onStructuredFamilyDecision?: (
    family: string,
    apply: boolean,
  ) => Promise<void> | void;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [position, setPosition] = useState(0);
  const [level, setLevel] = useState<"staff" | "context">("staff");
  const [saving, setSaving] = useState(false);
  const processing = saving || Boolean(review?.structuredOutputPending);
  const [deciding, setDeciding] = useState(false);
  const [expanded, setExpanded] = useState(reviewGroup === "base");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReview(null);
    setError(null);
    setPosition(0);
    const query = `?${new URLSearchParams({
      ...(engineId ? { engineId } : {}),
      group: reviewGroup,
    }).toString()}`;
    fetch(`/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/review${query}`)
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Unable to load recognition questions. Refresh to try again.",
          );
        const data = await response.json();
        if (!data || !Array.isArray(data.spots))
          throw new Error(
            "Unable to load recognition questions. Refresh to try again.",
          );
        return data;
      })
      .then((data) => {
        if (!cancelled) {
          setReview(data);
          setPosition(data.position || 0);
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load recognition questions. Refresh to try again.",
          );
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [engineId, jobId, pageNumber, reviewGroup]);

  useEffect(() => {
    const id = engineId || review?.engineId || "";
    onBusyChange?.(id, processing || loading);
    return () => onBusyChange?.(id, false);
  }, [engineId, review?.engineId, processing, loading, onBusyChange]);

  // A reload can land in the middle of materialization too. Keep polling and
  // withhold choices until the worker publishes the final questions/signature.
  useEffect(() => {
    if (!review?.structuredOutputPending) return;
    let cancelled = false;
    const query = new URLSearchParams({
      engineId: review.engineId || engineId || "",
      group: reviewGroup,
    }).toString();
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/review?${query}`,
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const next: Review = await response.json();
        if (cancelled || next.structuredOutputPending) return;
        setReview(next);
        setPosition(next.position || 0);
        setLevel("staff");
      } catch {
        // Keep the visible processing state; a transient read failure does not
        // mean the saved correction was lost or the worker has finished.
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    review?.structuredOutputPending,
    review?.engineId,
    engineId,
    jobId,
    pageNumber,
    reviewGroup,
  ]);

  // Reset the zoom when moving on: the previous spot's context says nothing
  // about the next one.
  const advance = useCallback(() => {
    setPosition((current) => current + 1);
    setLevel("staff");
    setError(null);
  }, []);

  const navigate = async (next: number) => {
    if (!onProgress || !review) {
      setPosition(next);
      setLevel("staff");
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onProgress(next, review.contentSignature);
      setPosition(next);
      setLevel("staff");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save review progress.",
      );
    } finally {
      setSaving(false);
    }
  };

  const finishStructuredFamily = useCallback(
    async (apply: boolean) => {
      if (reviewGroup === "base" || !onStructuredFamilyDecision) return;
      setDeciding(true);
      setError(null);
      try {
        await onStructuredFamilyDecision(reviewGroup, apply);
        setPosition(review?.spots.length || 0);
        setExpanded(false);
      } catch {
        setError("That head choice could not be saved. Please try again.");
      } finally {
        setDeciding(false);
      }
    },
    [onStructuredFamilyDecision, review?.spots.length, reviewGroup],
  );

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
            body: JSON.stringify({
              spotId,
              chosen: value,
              engineId: review?.engineId,
              contentSignature: review?.contentSignature,
              reviewGroup,
            }),
          },
        );
        if (!response.ok) {
          const failure =
            typeof response.json === "function"
              ? await response.json().catch(() => null)
              : null;
          const message =
            typeof failure?.message === "string" ? failure.message : null;
          if (
            response.status === 409 &&
            message ===
              "Your previous choice is still being processed. Wait for the next question."
          ) {
            setReview((current) =>
              current ? { ...current, structuredOutputPending: true } : current,
            );
            return;
          }
          if (
            response.status === 409 &&
            (!message ||
              message ===
                "Scanner review content changed; refresh and try again")
          ) {
            const refreshed = await fetch(
              `/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/review?${new URLSearchParams(
                {
                  engineId: review?.engineId || engineId || "",
                  group: reviewGroup,
                },
              ).toString()}`,
            );
            if (refreshed.ok) {
              setReview(await refreshed.json());
              setPosition(0);
              setLevel("staff");
            }
            throw new Error("review changed");
          }
          throw new Error(message || "save failed");
        }
        const result = await response.json();
        if (!result?.contentSignature)
          throw new Error("save response was incomplete");
        if (result.pending) {
          setReview((current) =>
            current ? { ...current, structuredOutputPending: true } : current,
          );
          return;
        }
        setReview((current) =>
          current
            ? { ...current, contentSignature: result.contentSignature }
            : current,
        );
        advance();
      } catch (cause) {
        // Keep the reviewer on the spot they were working: silently advancing
        // would lose their decision without saying so.
        setError(
          cause instanceof Error && cause.message === "review changed"
            ? "This page changed while you were reviewing it. The latest spots are shown; choose again."
            : cause instanceof Error && cause.message !== "save failed"
              ? cause.message
              : "That could not be saved. Try again, or skip this one.",
        );
      } finally {
        setSaving(false);
      }
    },
    [
      advance,
      engineId,
      jobId,
      pageNumber,
      review?.contentSignature,
      review?.engineId,
      reviewGroup,
    ],
  );

  if (loading) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Loading review…
      </p>
    );
  }
  if (!review) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-300">
        {error || "Unable to load recognition questions. Refresh to try again."}
      </p>
    );
  }
  if (review.spots.length === 0 && review.structuredOutputPending) {
    return (
      <p
        role="status"
        aria-busy="true"
        className="flex items-center gap-2 text-sm text-cyan-800 dark:text-cyan-200"
      >
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
        />
        Updating the score and loading the next question…
      </p>
    );
  }
  if (review.spots.length === 0) {
    return (
      <details className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {REVIEW_GROUP_LABELS[reviewGroup] || reviewGroup} · no uncertain
          questions
        </summary>
        <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Nothing in this group looked uncertain.
          </p>
          {reviewGroup !== "base" && onStructuredFamilyDecision && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={deciding}
                onClick={() => void finishStructuredFamily(true)}
                className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                Use this head
              </button>
              <button
                type="button"
                disabled={deciding}
                onClick={() => void finishStructuredFamily(false)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Leave this head out
              </button>
            </div>
          )}
          {error && (
            <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">
              {error}
            </p>
          )}
        </div>
      </details>
    );
  }

  const spot = review.spots[position];
  const remaining = review.spots.length - position;
  const groupLabel = REVIEW_GROUP_LABELS[reviewGroup] || reviewGroup;

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 px-4 py-3 marker:hidden">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {groupLabel} · {review.spots.length} uncertain
        </span>
        {spot && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            question {position + 1} of {review.spots.length}
          </span>
        )}
      </summary>
      <section
        aria-busy={processing}
        className="border-t border-slate-200 p-4 dark:border-slate-800"
      >
        {processing && (
          <p
            role="status"
            className="mb-3 flex items-center gap-2 text-sm text-cyan-800 dark:text-cyan-200"
          >
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            />
            {review.structuredOutputPending
              ? "Updating the score and loading the next question…"
              : "Saving your progress and loading the next question…"}
          </p>
        )}
        <h3 className="mb-3 text-sm font-medium text-slate-700 dark:text-slate-300">
          Check {engineLabel ? `${engineLabel}'s` : "the"}{" "}
          {groupLabel.toLowerCase()}
        </h3>

        {review.readOnly && (
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            These are the original recognition questions. This page has a merged
            score; make further changes in the merged score editor.
          </p>
        )}
        {review.suitability.unsuitable && (
          // Say so rather than presenting hundreds of questions as though the page
          // were nearly right. Never a gate: the queue is still below.
          <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            The scanner was unsure about{" "}
            {percent(review.suitability.askableRatio)} of this page, so it is
            probably past what automatic recognition can do — handwritten or
            heavily marked scores usually are. You can still work through the
            list, but the Score Editor may be faster.
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
                onClick={() => void navigate(Math.max(0, position - 1))}
                className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Back to the last one
              </button>
            )}
            {reviewGroup !== "base" && onStructuredFamilyDecision && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => void finishStructuredFamily(true)}
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  Use {groupLabel.toLowerCase()} output
                </button>
                <button
                  type="button"
                  disabled={deciding}
                  onClick={() => void finishStructuredFamily(false)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Leave {groupLabel.toLowerCase()} out
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {/*
            The container hugs the image rather than filling the row. The band
            below is positioned in percentages, and those are of *this* box — so
            with a full-width container and `object-contain` the picture would
            letterbox inside it and the highlight would drift off the symbol the
            moment the crop's aspect ratio changed, which is exactly what
            switching to the surrounding staves does.
          */}
            <div className="relative mx-auto w-fit overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/proxy/scanner/jobs/${jobId}/pages/${pageNumber}/crop/${spot.id}?${new URLSearchParams(
                  {
                    level,
                    engineId: review.engineId,
                    contentSignature: review.contentSignature,
                    group: reviewGroup,
                  },
                ).toString()}`}
                alt={`Page ${pageNumber}, the passage the scanner was unsure about`}
                className="block max-h-80 w-auto max-w-full"
              />
              {/* Without this the question is unanswerable: a staff crop can hold
                thirty notes, and "which duration is this?" needs to say which.
                Drawn at both levels: the context crop grows only vertically, so
                the band's horizontal position stays correct. */}
              {spot.band && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute border-2 border-cyan-500 bg-cyan-400/20"
                  style={{
                    left: `${spot.band.start * 100}%`,
                    width: `${Math.max(2, (spot.band.end - spot.band.start) * 100)}%`,
                    // At `staff` the crop is the staff, so the band fills it. At
                    // `context` the crop also holds the staves above and below,
                    // and a full-height band would point at all three to ask
                    // about a symbol on one.
                    top:
                      level === "context" && spot.band.contextTop !== undefined
                        ? `${spot.band.contextTop * 100}%`
                        : 0,
                    height:
                      level === "context" &&
                      spot.band.contextHeight !== undefined
                        ? `${spot.band.contextHeight * 100}%`
                        : "100%",
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
                onClick={() =>
                  setLevel(level === "staff" ? "context" : "staff")
                }
                className="rounded border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {level === "staff"
                  ? "Show the staves around it"
                  : "Back to this staff"}
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
                    disabled={processing || review.readOnly}
                    onClick={() => void choose(spot.id, option.value)}
                    className="flex w-full items-center gap-2 rounded border border-slate-200 px-3 py-2 text-left hover:border-cyan-400 hover:bg-cyan-50 disabled:opacity-50 dark:border-slate-800 dark:hover:border-cyan-700 dark:hover:bg-cyan-950/40"
                  >
                    <span className="text-slate-900 dark:text-slate-100">
                      {option.label}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {percent(option.confidence)}
                      {option.recognised ? " — what the scanner chose" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {error && (
              <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">
                {error}
              </p>
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
                  onClick={() => void navigate(Math.max(0, position - 1))}
                  disabled={processing || position === 0}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => void navigate(position + 1)}
                  disabled={processing}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Skip
                </button>
                {reviewGroup === "base" ? (
                  <button
                    type="button"
                    onClick={() => void navigate(review.spots.length)}
                    disabled={processing}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    Skip remaining base questions
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void finishStructuredFamily(true)}
                      disabled={processing || deciding}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40"
                    >
                      Skip remaining and use this head
                    </button>
                    <button
                      type="button"
                      onClick={() => void finishStructuredFamily(false)}
                      disabled={processing || deciding}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      Skip remaining and leave this head out
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </details>
  );
}
