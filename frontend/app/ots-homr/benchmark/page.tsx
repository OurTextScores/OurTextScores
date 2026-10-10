import type { Metadata } from "next";
import Link from "next/link";

import { Section, Table } from "../ui";

export const metadata: Metadata = {
  title: "OTS-HOMR benchmark | OurTextScores",
  description:
    "Staff-by-staff results for OTS-HOMR against HOMR on string quartet scans, mixed repertoire and voice and piano scans.",
};

const link = "text-blue-600 hover:underline dark:text-blue-400";

const SETS = [
  {
    id: "quartets",
    title: "String quartet scans",
    support: "792 staves from 9 scores",
    models: [
      ["HOMR", "14.47%", "14.64%", "9.59%", "146 / 792", "91.68%", "0"],
      ["OTS-HOMR", "5.25%", "5.26%", "0.91%", "469 / 792", "95.04%", "0"],
    ],
    change: "−9.23 points (95% interval −12.37 to −7.00)",
    branches: [
      ["Pitch", "2.85%", "0.61%"],
      ["Rhythm", "7.06%", "2.93%"],
      ["Accidentals", "5.52%", "0.90%"],
      ["Articulation", "3.28%", "2.12%"],
      ["Slurs", "1.88%", "0.74%"],
      ["Position", "1.22%", "0.46%"],
    ],
    numerators: "No five- or twelve-beat time signatures in this set.",
  },
  {
    id: "mixed",
    title: "Mixed repertoire",
    support: "3,422 staves from 632 scores",
    models: [
      ["HOMR", "7.44%", "8.44%", "7.32%", "1,460 / 3,422", "84.27%", "0"],
      ["OTS-HOMR", "4.52%", "4.57%", "4.07%", "2,132 / 3,422", "88.62%", "0"],
    ],
    change: "−2.92 points (95% interval −4.05 to −2.03)",
    branches: [
      ["Pitch", "4.58%", "2.96%"],
      ["Rhythm", "4.46%", "2.70%"],
      ["Accidentals", "4.88%", "2.39%"],
      ["Articulation", "3.18%", "1.81%"],
      ["Slurs", "3.53%", "2.09%"],
      ["Position", "3.15%", "1.71%"],
    ],
    numerators:
      "Five-beat time signatures read correctly: HOMR 0 of 84, OTS-HOMR 48 of 84. Twelve-beat: HOMR 0 of 115, OTS-HOMR 70 of 115.",
  },
  {
    id: "voice-piano",
    title: "Voice and piano scans",
    support: "300 staves from 13 scores",
    models: [
      ["HOMR", "5.76%", "5.86%", "5.93%", "97 / 300", "87.31%", "0"],
      ["OTS-HOMR", "2.59%", "2.62%", "1.26%", "162 / 300", "94.10%", "0"],
    ],
    change: "−3.16 points (95% interval −5.10 to −1.54)",
    branches: [
      ["Pitch", "2.17%", "0.78%"],
      ["Rhythm", "2.04%", "1.23%"],
      ["Accidentals", "3.53%", "0.75%"],
      ["Articulation", "1.41%", "0.63%"],
      ["Slurs", "1.59%", "0.84%"],
      ["Position", "1.08%", "0.35%"],
    ],
    numerators:
      "Twelve-beat time signatures: HOMR 0 of 2, OTS-HOMR 1 of 2 (too few to say anything).",
  },
];

export default function BenchmarkPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10 lg:px-10">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Link href="/ots-homr" className={link}>
          OTS-HOMR
        </Link>
      </p>
      <h1 className="mt-1 text-3xl font-semibold text-slate-900 dark:text-slate-100">
        OTS-HOMR against HOMR, staff by staff
      </h1>
      <p className="mt-3 text-base leading-7 text-slate-700 dark:text-slate-300">
        Both engines read the same staves from three test sets, and each reading
        was compared with the correct one. Lower error is better. Every staff
        counts, including the ones an engine could not read (none failed). Read{" "}
        <Link href="/ots-homr/benchmark/method" className={link}>
          how we measured
        </Link>{" "}
        before drawing conclusions from the numbers.
      </p>

      <Section id="summary" title="Summary">
        <Table
          head={[
            "Test set",
            "Staves / scores",
            "HOMR error",
            "OTS-HOMR error",
            "Change",
          ]}
          rows={SETS.map((set) => [
            set.title,
            set.support.replace(" staves from ", " / ").replace(" scores", ""),
            set.models[0][1],
            set.models[1][1],
            set.change,
          ])}
          emphasis={undefined}
        />
        <p>
          The error rate counts the symbols — notes, rests, accidentals,
          articulations, slurs, positions — that had to be added, removed or
          changed to turn a reading into the correct one, divided by the number
          of symbols in the correct reading. Time-signature numbers are left out
          of this main figure so the two engines are compared on what both can
          read.
        </p>
      </Section>

      {SETS.map((set) => (
        <Section key={set.id} id={set.id} title={set.title}>
          <p className="text-slate-600 dark:text-slate-400">{set.support}</p>
          <Table
            head={[
              "Engine",
              "Symbol error",
              "Error incl. time-signature numbers",
              "Note pitch or accidental error",
              "Staves read perfectly",
              "Position accuracy",
              "Failed",
            ]}
            rows={set.models}
            emphasis={1}
          />
          <p>
            Change in symbol error:{" "}
            <span className="font-semibold">{set.change}</span>. The interval
            comes from resampling whole scores, so related staves are not
            counted as independent evidence.
          </p>
          <p className="font-semibold text-slate-800 dark:text-slate-200">
            Error by kind of symbol
          </p>
          <Table
            head={["Kind of symbol", "HOMR", "OTS-HOMR"]}
            rows={set.branches}
          />
          <p>{set.numerators}</p>
        </Section>
      ))}

      <Section id="limits" title="What these numbers do and do not show">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            They measure how well single staves are read. They say nothing
            directly about whole-page results, layout, or the lyrics and text
            features.
          </li>
          <li>
            The test staves were looked at during development, so these are
            descriptive benchmark figures, not a fresh test.
          </li>
          <li>
            The quartet figure comes from nine scores. The correct answers for
            all three sets were built by us and can contain errors.
          </li>
          <li>
            Both engines were run through the same software, not through each
            engine&rsquo;s own full pipeline, so staff reading is compared like
            for like.
          </li>
        </ul>
      </Section>

      <div className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-700">
        <Link href="/ots-homr" className={link}>
          &larr; Back to OTS-HOMR
        </Link>
      </div>
    </main>
  );
}
