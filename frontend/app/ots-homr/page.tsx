import type { Metadata } from "next";
import Link from "next/link";

import { Figure, Section, Table } from "./ui";

export const metadata: Metadata = {
  title: "OTS-HOMR | OurTextScores",
  description:
    "The scanner's engine for ensemble scores: how much more accurately it reads than HOMR, and what it adds.",
};

/* Every number on this page is a measurement with its support stated, and describes the
   OTS-HOMR engine the scanner runs (the pinned core), compared with the HOMR engine the
   scanner also offers. The sources are homr's docs/PIPELINE.md and the claims table in
   homr's docs/; if this page and they disagree, they win. */

/* The galleries are static pages in `public/`: they build their own compare embeds
   against the score editor, and rewriting them in React would be transcription with a
   chance of error and no gain. */
const GALLERIES = [
  {
    title: "HOMR and OTS-HOMR on the same pages",
    caption:
      "whole pages of clean songs read by both, compared with the encoded score; every page where they differ",
    src: "/upstream-vs-ots-gallery.html",
  },
  {
    title: "Lyrics and staff text, before and after review",
    caption:
      "the scan result, and the same page with every suggested lyric, direction and dynamic accepted",
    src: "/lyrics-review-gallery.html",
  },
];

const link = "text-blue-600 hover:underline dark:text-blue-400";

export default function OtsHomrPage() {
  return (
    <main className="mx-auto w-full max-w-[110rem] px-6 py-10 lg:px-10">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Scanner engines
      </p>
      <h1 className="mt-1 text-3xl font-semibold text-slate-900 dark:text-slate-100">
        OTS-HOMR
      </h1>
      <p className="mt-3 max-w-3xl text-base leading-7 text-slate-700 dark:text-slate-300">
        The scanner engine built for scores where several staves sound at once —
        string quartets, piano trios, voice and piano. It is a fork of{" "}
        <a
          href="https://github.com/liebharc/homr"
          target="_blank"
          rel="noreferrer noopener"
          className={link}
        >
          HOMR
        </a>{" "}
        that makes fewer mistakes on the same pages, reads the engraved details
        around the notes, and suggests the lyrics, written directions and
        dynamic marks it finds for you to review.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Figure
          value="14.5% → 5.3%"
          label="String quartet scans"
          detail="Symbols read wrongly, HOMR → OTS-HOMR; 792 staves, 9 scores"
        />
        <Figure
          value="7.4% → 4.5%"
          label="Mixed repertoire"
          detail="Symbols read wrongly, HOMR → OTS-HOMR; 3,422 staves, 632 scores"
        />
        <Figure
          value="5.8% → 2.6%"
          label="Voice and piano scans"
          detail="Symbols read wrongly, HOMR → OTS-HOMR; 300 staves, 13 scores"
        />
      </div>
      <p className="mt-3 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        <Link href="/ots-homr/benchmark" className={link}>
          Full results
        </Link>{" "}
        &middot;{" "}
        <Link href="/ots-homr/benchmark/method" className={link}>
          How we measured
        </Link>
      </p>

      <Section id="which-engine" title="Which engine should I choose?">
        <p>
          The scanner offers three. They differ in what they were built for.
        </p>
        <Table
          head={["Engine", "In short"]}
          rows={[
            [
              "OTS-HOMR",
              "Built for ensemble scores. Reads staves together, reads beams, stems, ties and slurs as printed, and suggests lyrics, directions and dynamics for review. This page.",
            ],
            [
              "HOMR",
              "The open-source engine OTS-HOMR is forked from, maintained by its own authors.",
            ],
            [
              "Transcoda",
              "A different architecture entirely. Useful as a second opinion when a page reads badly.",
            ],
          ]}
          emphasis={0}
        />
        <p>
          There is no penalty for trying more than one. A page that defeats one
          engine often yields to another, and the comparison view shows you the
          two readings side by side.
        </p>
      </Section>

      <Section id="accuracy" title="How much more accurately it reads">
        <p>
          We took staves from scores neither engine was built from, had each
          engine read them, and counted every symbol — note, rest, accidental,
          articulation, slur, position — that had to be added, removed or
          changed to turn the engine&rsquo;s reading into the correct one. The
          error rate is that count divided by the number of symbols in the
          correct reading. Lower is better.
        </p>
        <Table
          head={[
            "Test set",
            "Staves / scores",
            "HOMR error",
            "OTS-HOMR error",
            "Change (95% interval)",
          ]}
          rows={[
            [
              "String quartet scans",
              "792 / 9",
              "14.47%",
              "5.25%",
              "−9.23 points (−12.37, −7.00)",
            ],
            [
              "Mixed repertoire",
              "3,422 / 632",
              "7.44%",
              "4.52%",
              "−2.92 points (−4.05, −2.03)",
            ],
            [
              "Voice and piano scans",
              "300 / 13",
              "5.76%",
              "2.59%",
              "−3.16 points (−5.10, −1.54)",
            ],
          ]}
        />
        <p>
          The improvement shows on every kind of symbol on every set. Wrong
          pitches or accidentals fall from 9.59% to 0.91% on quartet scans, from
          7.32% to 4.07% on mixed repertoire, and from 5.93% to 1.26% on voice
          and piano. OTS-HOMR also reads time signatures HOMR cannot, such as
          five-beat and twelve-beat bars: 48 of 84 and 70 of 115 correct on
          mixed repertoire, none for HOMR.
        </p>
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="font-semibold">Read these as a benchmark.</span> The
          test staves were looked at during development, they are single staves
          rather than whole pages, and the correct answers for them were built
          by us and can contain errors of their own. The quartet figure rests on
          nine scores, a small slice of the 84 quartet scores we have corrected
          scans of.
        </p>
      </Section>

      <Section id="staves-together" title="Reading the staves together">
        <p>
          HOMR reads a page one staff at a time. In a quartet the four staves
          play the same bars, so their barlines have to land in the same places;
          when they don&rsquo;t, something was misread. OTS-HOMR uses that:
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            When a staff disagrees with the others about where bars fall, it
            tries the other likely readings of its doubtful rhythms and keeps
            the one that fits the other staves best. Over 200 pages this cut
            structural disagreements from 428 to 339, improved 81 of 899
            systems, and made{" "}
            <span className="font-semibold">no page worse</span>.
          </li>
          <li>
            When most staves state one key or time signature and a few state
            another, it moves the few onto a value another staff actually read.
            It never invents one and never breaks a tie.
          </li>
          <li>
            When one staff&rsquo;s barlines drift from the rest, it tries other
            likely readings of that one bar, and keeps one only if its barlines
            then match the other staves exactly. Checking against the other
            staves is what makes this safe, and it is why this can&rsquo;t be
            done on every staff from the start: each alternative means decoding
            again, and a single staff cannot tell which reading is right.
          </li>
        </ul>
        <p>
          These apply to systems of at least three staves (four for the
          barline-drift repair), so they matter for quartets and trios, not for
          a single staff or a voice and piano pair.
        </p>
        <p>
          It is deliberately cautious: music in several metres or keys at once
          is real, and a &ldquo;fix&rdquo; that overrides a genuine disagreement
          is worse than none.
        </p>
      </Section>

      <Section id="engraving" title="Notation as printed">
        <p>
          Standard recognition gives you pitches and rhythms and leaves the rest
          to a default. OTS-HOMR also writes out the beam grouping, stem
          directions, ties, slurs and horizontal spacing it reads from the page,
          so you can see and edit them as separate marks. Reading them is harder
          than reading the notes: on clean song pages its beaming matches the
          printed score about as often as the editor&rsquo;s own default beaming
          does, so check beams and slurs as you would any other mark.
        </p>
      </Section>

      <Section id="lyrics" title="Lyrics, directions and dynamics">
        <p>
          After a page is scanned, OTS-HOMR suggests the lyrics, written
          directions (<em>cresc.</em>, <em>rit.</em>, <em>dolce</em>…) and
          dynamic marks it found, each tied to a note, for you to check beside
          the original. Nothing is added to your score until you accept it, and
          marks it cannot attach to a note are still offered so you can choose
          one.
        </p>
        <p>On clean song pages, the figures we measured:</p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            About nine in ten suggested lyric placements were right (109 of 120,
            on pages the rules were not tuned on).
          </li>
          <li>
            About half of the printed directions and dynamics on a page were
            offered, and about two in three of the offered ones landed in the
            right measure by a strict check against the encoded score.
          </li>
        </ul>
        <p>
          Treat it as a first pass: it saves typing the lyrics and many of the
          marks, and you still check every one.
        </p>
      </Section>

      <Section id="examples" title="Worked examples" wide>
        <p className="max-w-5xl">
          Two galleries, both on whole pages that no development step used. The
          first puts HOMR and OTS-HOMR on the same pages and shows every page
          where they differ, including how little separates them on clean
          engravings. The second shows what the review-assisted lyrics,
          directions and dynamics add to a scanned page.
        </p>
        <p className="max-w-5xl text-slate-600 dark:text-slate-400">
          The comparisons open in the score editor, the same one the scanner
          review tools use, so you can page through a system at a time.
        </p>
        {GALLERIES.map((gallery) => (
          /* Full-bleed: `50% - 50vw` is measured from this element's own centred
             parent, so it lands on the viewport edge whatever the ancestors cap the
             width at - which matters here because the section's prose is deliberately
             capped and these are not prose. `100vw` counts the scrollbar, so the width
             subtracts it back out rather than causing a horizontal scroll. */
          <figure
            key={gallery.src}
            className="mt-8"
            style={{
              width: "100vw",
              marginLeft: "calc(50% - 50vw)",
              marginRight: "calc(50% - 50vw)",
              maxWidth: "100vw",
            }}
          >
            <figcaption className="mb-2 px-6 lg:px-10">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {gallery.title}
              </span>
              <span className="ml-2 text-slate-600 dark:text-slate-400">
                {gallery.caption}
              </span>
            </figcaption>
            <iframe
              src={gallery.src}
              title={gallery.title}
              loading="lazy"
              className="h-[88vh] min-h-[700px] w-full border-y border-slate-200 bg-white dark:border-slate-700"
            />
          </figure>
        ))}
      </Section>

      <Section id="limits" title="What it does not do">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="font-semibold">Every result is a draft.</span> That
            is true of all music recognition; the review tools exist because of
            it.
          </li>
          <li>
            <span className="font-semibold">
              It was measured on quartets, voice and piano, and mixed
              repertoire.
            </span>{" "}
            We have not measured full orchestral or very dense scores.
          </li>
          <li>
            <span className="font-semibold">
              It misses about half of the printed directions and dynamics.
            </span>{" "}
            Loud marks such as <em>f</em>, <em>ff</em> and <em>mf</em> are found
            less reliably than soft ones, and wedge-shaped crescendo and
            diminuendo signs are not read.
          </li>
          <li>
            <span className="font-semibold">
              Pages without music mislead it.
            </span>{" "}
            A cover or an illustration can come back as an empty or nonsense
            measure, so leave those pages out of the scan.
          </li>
        </ul>
      </Section>

      <Section id="provenance" title="Provenance and licensing">
        <p>
          OTS-HOMR is derived from{" "}
          <a
            href="https://github.com/liebharc/homr"
            target="_blank"
            rel="noreferrer noopener"
            className={link}
          >
            HOMR
          </a>{" "}
          by Christian Liebhardt and contributors, and inherits its AGPL-3.0
          licence. The recognition improvements described here are ours; the
          visual encoder and decoder they build on are HOMR&rsquo;s.
        </p>
        <p>
          Training data is built from{" "}
          <a
            href="https://github.com/OpenScore/StringQuartets"
            target="_blank"
            rel="noreferrer noopener"
            className={link}
          >
            OpenScore String Quartets
          </a>
          ,{" "}
          <a
            href="https://github.com/OpenScore/Lieder"
            target="_blank"
            rel="noreferrer noopener"
            className={link}
          >
            OpenScore Lieder
          </a>{" "}
          and scans from IMSLP.
        </p>
      </Section>

      <div className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-700">
        <Link href="/scanner" className={link}>
          &larr; Back to the scanner
        </Link>
      </div>
    </main>
  );
}
