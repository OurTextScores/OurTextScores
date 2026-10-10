import type { Metadata } from "next";
import Link from "next/link";

import { Section } from "../../ui";

export const metadata: Metadata = {
  title: "How we measured OTS-HOMR | OurTextScores",
  description:
    "How the OTS-HOMR and HOMR benchmark was run, what was counted, and what it cannot tell you.",
};

const link = "text-blue-600 hover:underline dark:text-blue-400";

export default function MethodPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10 lg:px-10">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Link href="/ots-homr/benchmark" className={link}>
          Benchmark
        </Link>
      </p>
      <h1 className="mt-1 text-3xl font-semibold text-slate-900 dark:text-slate-100">
        How we measured
      </h1>
      <p className="mt-3 text-base leading-7 text-slate-700 dark:text-slate-300">
        A short, plain account of how OTS-HOMR and HOMR were compared, fixed
        before the results were read.
      </p>

      <Section id="what" title="What was compared">
        <p>
          The OTS-HOMR engine the scanner runs, and the HOMR engine the scanner
          offers (HOMR&rsquo;s released model). Both read exactly the same
          picture of each staff, prepared the same way, through the same
          software, so the only difference is the recognition model.
        </p>
      </Section>

      <Section id="data" title="The test sets">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="font-semibold">String quartet scans:</span> 792
            staves from 9 scores, scanned pages paired with the OpenScore
            quartet editions.
          </li>
          <li>
            <span className="font-semibold">Mixed repertoire:</span> all 3,422
            staves of the validation split of a large collection of public
            scores, from 632 scores.
          </li>
          <li>
            <span className="font-semibold">Voice and piano scans:</span> 300
            staves from 13 scores, scanned pages paired with the OpenScore
            Lieder editions.
          </li>
        </ul>
        <p>
          Each set is reported separately. We did not read any test split
          reserved for the end, and no model was chosen or retrained using these
          results.
        </p>
      </Section>

      <Section id="counting" title="What was counted">
        <p>
          Each staff is turned into a sequence of symbols, each described by six
          things: pitch, rhythm, accidental, articulation, slur and position.
          The main figure is the number of symbols that must be inserted,
          deleted or changed to turn the engine&rsquo;s reading into the correct
          one, divided by the number of symbols in the correct reading.
        </p>
        <p>
          Time-signature numbers are removed from both readings for the main
          figure, because HOMR&rsquo;s released model cannot output some of
          them; the error including those numbers is shown alongside, and the
          time signatures OTS-HOMR adds are reported separately. A staff an
          engine could not read counts as an empty reading, not as an exclusion;
          none failed.
        </p>
        <p>
          We also report the errors for each kind of symbol, pitch and
          accidental errors on notes alone, the share of staves read perfectly,
          and a simple position accuracy.
        </p>
      </Section>

      <Section id="intervals" title="Confidence intervals">
        <p>
          The intervals come from resampling whole scores 2,000 times (with a
          fixed random seed), not individual staves, because staves from one
          score are not independent: they share a composer, an engraving style
          and often a typo. An improvement is reported only when the interval
          supports it; neutral or worse results are reported the same way.
        </p>
      </Section>

      <Section id="limits" title="What this cannot tell you">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            It measures reading single staves. It says nothing about page
            layout, whole-page correctness, or the lyrics and text features.
          </li>
          <li>
            The test staves had been looked at in earlier work, so this
            describes benchmark performance and is not evidence of how the
            engine does on completely new material.
          </li>
          <li>
            The correct answers were built by us from the editions; where the
            edition or our pairing is wrong, both engines are marked wrong
            alike.
          </li>
          <li>
            Run times were taken while other jobs were using the same machine,
            so we make no speed claims from this benchmark.
          </li>
        </ul>
      </Section>

      <div className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-700">
        <Link href="/ots-homr/benchmark" className={link}>
          &larr; Back to the results
        </Link>
      </div>
    </main>
  );
}
