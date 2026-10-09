"use client";

import {
  DYNAMIC_MARKS,
  blankDirection,
  type DirectionDecision,
  type DirectionItem,
} from "./direction-review-model";

/**
 * Written directions and dynamic marks the scanner read from the page. Each card shows the picture with the
 * numbered notes, the text it read, the note the mark goes on and whether it is printed above or below;
 * "Accept" is the reviewer's check of all of that. Nothing is written until the page-level confirmation.
 */
export default function DirectionsReview({
  base,
  items,
  decisions,
  onChange,
}: {
  base: string;
  items: DirectionItem[];
  decisions: Record<string, DirectionDecision>;
  onChange: (id: string, next: DirectionDecision) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-8" aria-label="Directions and dynamics">
      <h2 className="text-lg font-semibold">Directions and dynamics</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Written directions (cresc., dolce, rit.…) and dynamic marks (p, mf…) read from the scan. Check the text, the
        note it belongs to and whether it sits above or below, then Accept; Exclude anything that is not one.
      </p>
      {items.map((item) => {
        const d = decisions[item.id] ?? blankDirection(item);
        const set = (patch: Partial<DirectionDecision>) => onChange(item.id, { ...d, ...patch });
        return (
          <article key={item.id} className="border-t border-slate-300 py-4 dark:border-slate-700">
            <p className="text-sm">
              {item.kind === "dynamic" ? "Dynamic mark" : "Written direction"} (read by{" "}
              {item.source === "classifier" ? "the dynamics classifier" : "OCR"}, not yet checked)
            </p>
            {item.unplaced && (
              <p className="mt-1 text-xs text-amber-800" role="note">
                The scanner could not tell which note this belongs to: choose the note it governs, or exclude it.
              </p>
            )}
            <p className="mt-1 text-base">
              <span className="text-xs text-slate-500">Read from the scan: </span>
              <strong>{item.initialText}</strong>
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${base}/${encodeURIComponent(item.id)}/crop${item.noteChoices.length > 0 ? "?view=placement" : ""}`}
              alt="Direction with its staff; numbered lines mark the notes it can go on"
              className="mt-1 max-w-full"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              {item.kind === "dynamic" ? (
                <label>
                  Mark{" "}
                  <select
                    aria-label={`Dynamic mark for ${item.initialText}`}
                    value={d.mark}
                    onChange={(e) => set({ mark: e.target.value, text: e.target.value })}
                    className="rounded border px-1"
                  >
                    {DYNAMIC_MARKS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  Text{" "}
                  <input
                    type="text"
                    aria-label={`Direction text for ${item.initialText}`}
                    value={d.text}
                    onChange={(e) => set({ text: e.target.value })}
                    className="w-56 rounded border px-1"
                  />
                </label>
              )}
              <label>
                On note{" "}
                <select
                  aria-label={`Note for ${item.initialText}`}
                  value={d.noteId ?? ""}
                  onChange={(e) => set({ noteId: e.target.value || null })}
                  className="rounded border px-1"
                >
                  <option value="">{item.unplaced ? "(choose a note)" : "(none: leave out)"}</option>
                  {item.noteChoices.map((n) => (
                    <option key={n.noteId} value={n.noteId}>
                      {n.number} · {n.pitch} · m{n.measure}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Printed{" "}
                <select
                  aria-label={`Placement for ${item.initialText}`}
                  value={d.placement}
                  onChange={(e) => set({ placement: e.target.value as "above" | "below" })}
                  className="rounded border px-1"
                >
                  <option value="above">above the staff</option>
                  <option value="below">below the staff</option>
                </select>
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40 dark:border-slate-600"
                disabled={(item.kind === "dynamic" ? d.mark : d.text).trim() === "" || !d.noteId}
                onClick={() => set({ state: "accept" })}
              >
                Accept
              </button>
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-0.5 dark:border-slate-600"
                onClick={() => set({ state: "exclude" })}
              >
                Exclude
              </button>
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-0.5 dark:border-slate-600"
                onClick={() => onChange(item.id, blankDirection(item))}
              >
                Reset
              </button>
              <span data-testid={`direction-state-${item.id}`}>{d.state}</span>
            </div>
          </article>
        );
      })}
    </section>
  );
}
