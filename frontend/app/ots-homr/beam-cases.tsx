"use client";

import { useState } from "react";

/* Counts are from `beam_discrepancy_inventory.py` over 122 OpenScore quartets,
   823,217 flagged notes, of which 149,459 differ from the deterministic rule. They are
   written here rather than fetched because they are a claim this page is making, and a
   claim should be reviewable in the diff that changes it. */
export type BeamCase = {
  id: string;
  title: string;
  count: number;
  share: string;
  what: string;
  who: "rule" | "engraver" | "neither";
};

export const BEAM_CASES: BeamCase[] = [
  {
    id: "primary_longer_engraved_0",
    title: "The engraver joins what the rule splits",
    count: 43352,
    share: "29.0%",
    what: "One beamed group where the rule ends one and starts another.",
    who: "engraver",
  },
  {
    id: "primary_shorter_engraved_0",
    title: "The engraver splits what the rule joins",
    count: 43272,
    share: "29.0%",
    what: "Two groups where the rule runs one straight through.",
    who: "engraver",
  },
  {
    id: "crosses_beat_0",
    title: "A beam crosses a beat",
    count: 24525,
    share: "16.4%",
    what: "The group spans a beat boundary the rule always breaks at.",
    who: "engraver",
  },
  {
    id: "hook_vs_flag_0",
    title: "A hook, where the rule writes a flag",
    count: 14100,
    share: "9.4%",
    what: "The short note of a dotted pair takes a partial beam. Which it is follows from the durations, so this is arithmetic the rule never implemented — not something only the page shows.",
    who: "rule",
  },
  {
    id: "beams_over_rest_0",
    title: "A beam runs over a rest",
    count: 12082,
    share: "8.1%",
    what: "The rule cannot express this at all: a rest ends a group by construction. Only a reader of the page can supply it.",
    who: "engraver",
  },
  {
    id: "unbeamed_exception_0",
    title: "Deliberately unbeamed",
    count: 7604,
    share: "5.1%",
    what: "The engraver leaves notes flagged where the rule would beam them. This is the case that cannot be expressed by leaving the beams out, because silence reads as “beam this automatically”.",
    who: "engraver",
  },
  {
    id: "primary_shifted_0",
    title: "Same length, different place",
    count: 2338,
    share: "1.6%",
    what: "Groups of equal size starting a note earlier or later.",
    who: "neither",
  },
  {
    id: "other_grouping_0",
    title: "Other grouping differences",
    count: 1711,
    share: "1.1%",
    what: "Both beam, at levels that do not line up.",
    who: "neither",
  },
  {
    id: "other_engraved_beam_0",
    title: "Beamed for no rule reason",
    count: 249,
    share: "0.2%",
    what: "The engraving beams where the rule flags, and neither a rest nor a beat explains it.",
    who: "engraver",
  },
  {
    id: "secondary_subdivision_0",
    title: "Secondary beams subdivided",
    count: 226,
    share: "0.2%",
    what: "The primary beam agrees; the shorter levels are broken up inside it.",
    who: "rule",
  },
];

const SOURCE: Record<BeamCase["who"], { label: string; className: string }> = {
  engraver: {
    label: "only the page can say",
    className:
      "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
  },
  rule: {
    label: "the rule could compute this",
    className:
      "bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  },
  neither: {
    label: "unclassified",
    className:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
};

function compareUrl(id: string) {
  const left = `/devs-assets/beam-cases/${id}__rule.musicxml`;
  const right = `/devs-assets/beam-cases/${id}__engraved.musicxml`;
  return (
    `/score-editor/index.html?compareLeft=${encodeURIComponent(left)}` +
    `&compareRight=${encodeURIComponent(right)}` +
    `&leftLabel=${encodeURIComponent("Automatic beaming (the rule)")}` +
    `&rightLabel=${encodeURIComponent("As engraved")}`
  );
}

export function BeamCaseList() {
  /* One editor per case is far too much to load at once, and most readers will open
     one or two. Each stays a button until asked for. */
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    /* Full-bleed, same reasoning as the galleries: the comparison is two readings side
       by side and wants the window, while the descriptions beside it do not. */
    <div
      className="mt-6 space-y-4"
      style={{
        width: "100vw",
        marginLeft: "calc(50% - 50vw)",
        marginRight: "calc(50% - 50vw)",
        maxWidth: "100vw",
      }}
    >
      {BEAM_CASES.map((item) => {
        const source = SOURCE[item.who];
        return (
          <div
            key={item.id}
            className="border-y border-slate-200 bg-white px-6 py-4 lg:px-10 dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {item.title}
              </span>
              <span className="tabular-nums text-slate-600 dark:text-slate-400">
                {item.count.toLocaleString()} notes · {item.share} of
                differences
              </span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${source.className}`}
              >
                {source.label}
              </span>
            </div>
            <p className="mt-1.5 max-w-4xl text-slate-700 dark:text-slate-300">
              {item.what}
            </p>
            <button
              type="button"
              onClick={() => setOpen((s) => ({ ...s, [item.id]: !s[item.id] }))}
              className="mt-3 rounded border border-emerald-700 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
            >
              {open[item.id] ? "Hide comparison" : "Show comparison"}
            </button>
            {open[item.id] ? (
              <iframe
                src={compareUrl(item.id)}
                title={item.title}
                className="mt-3 h-[78vh] min-h-[620px] w-full rounded border border-slate-200 bg-white dark:border-slate-700"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
