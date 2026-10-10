import type { Metadata } from "next";
import Link from "next/link";

import { BeamCaseList } from "./beam-cases";

export const metadata: Metadata = {
  title: "OTS-HOMR | OurTextScores",
  description:
    "The scanner's ensemble-score engine: what it reads better than upstream HOMR, what it still gets wrong, and how it was built.",
};

/* Numbers on this page are held-out measurements, not impressions, and each one
   carries its support so a reader can weigh it. They come from homr's own
   docs/PIPELINE.md, which is the authority when this page and it disagree. If you
   update a figure here, update it there first. */

function Figure({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      <div className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">
        {label}
      </div>
      {detail ? (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  id,
  title,
  children,
  wide = false,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  /* Prose is capped for readability; a section of full-bleed embeds must not be, because
     the breakout below measures from its parent's centre and a left-aligned capped
     parent is not centred - which lands the embeds off to one side. */
  wide?: boolean;
}) {
  return (
    <section id={id} className="mt-12 scroll-mt-8">
      <h2 className="border-b border-slate-200 pb-1.5 text-xl font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
        {title}
      </h2>
      <div
        className={`mt-3 space-y-3 text-sm leading-6 text-slate-700 dark:text-slate-300 ${
          wide ? "" : "max-w-5xl"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

function Table({
  head,
  rows,
  emphasis,
}: {
  head: string[];
  rows: string[][];
  emphasis?: number;
}) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead>
          <tr>
            {head.map((cell) => (
              <th
                key={cell}
                className="border-b border-slate-300 bg-slate-50 px-3 py-2 text-left font-semibold text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row[0]}
              className={
                emphasis === index
                  ? "bg-amber-50 dark:bg-amber-950/30"
                  : undefined
              }
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-slate-200 px-3 py-2 align-top tabular-nums text-slate-700 dark:border-slate-700 dark:text-slate-300"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* The galleries are static pages, served from `public/`, because they
   build their own compare embeds against the score editor and rewriting them in React
   would be transcription with a chance of error and no gain. They reference
   `/devs-assets/...` absolutely, which is why those live at the public root.

   `page-delta-gallery` is deliberately not here: it is 70MB of whole-page renders, and
   its own text says it ranks the magnitude of output change rather than correctness -
   the largest asset for the weakest claim. */
const GALLERIES = [
  {
    title: "Upstream homr and OTS-HOMR on the same pages",
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
        A fork of{" "}
        <a
          href="https://github.com/liebharc/homr"
          target="_blank"
          rel="noreferrer noopener"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          HOMR
        </a>{" "}
        specialised for scores where several staves sound at once — string
        quartets, piano trios, voice and piano. A new recognition core rebuilt
        from published training corpora makes fewer symbol errors than upstream
        on all three validation sets. The scanner also uses agreement between a
        system&rsquo;s staves to check and repair readings.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Figure
          value="14.47% → 5.22%"
          label="String quartet scans"
          detail="Symbol error rate; 792 staves, 9 scores"
        />
        <Figure
          value="7.44% → 4.69%"
          label="Mixed repertoire (PDMX)"
          detail="Symbol error rate; 3,422 staves, 632 scores"
        />
        <Figure
          value="5.76% → 2.53%"
          label="Voice and piano scans"
          detail="Symbol error rate; 300 staves, 13 scores"
        />
      </div>

      <Section id="which-engine" title="Which engine should I choose?">
        <p>
          The scanner offers three. They differ in what they were built for, not
          in quality alone.
        </p>
        <Table
          head={["Engine", "Best for", "Notes"]}
          rows={[
            [
              "OTS-HOMR",
              "Ensemble scores, where it gains most: quartets, trios, voice and piano",
              "This page. Reads cross-staff agreement; emits beams, stems, ties and slurs explicitly.",
            ],
            [
              "HOMR",
              "General-purpose recognition",
              "Upstream, actively maintained by its own authors. On the mixed repertoire we measured, the OTS-HOMR core made fewer errors, by a smaller margin than on ensemble scans, and also on the scores with a single track (solo instruments including piano: 9.23% → 6.33%, 1,407 staves, 156 scores). Solo keyboard is not separated from other solo instruments yet.",
            ],
            [
              "Transcoda",
              "A different architecture entirely",
              "Useful as a second opinion when a page reads badly.",
            ],
          ]}
          emphasis={0}
        />
        <p>
          There is no penalty for trying more than one. A page that defeats one
          engine often yields to another, and the comparison view will show you
          the two readings side by side.
        </p>
      </Section>

      <Section
        id="what-it-reads-better"
        title="The core rebuilt from public data"
      >
        <p>
          On 28 September 2026 we compared upstream HOMR checkpoint 426, the
          pinned OTS core, and <code>public-rareNum-20260927</code> on identical
          staff crops. All three used the same decoder and preprocessing, with
          their native vocabularies. This isolates core recognition: cross-staff
          repair and structured heads were disabled.
        </p>
        <p>
          The table measures symbol edit errors: insertions, deletions and
          substitutions per reference symbol. A symbol includes its pitch,
          rhythm, accidental, articulation, slur and staff position. Lower is
          better. Time-signature numerator symbols are excluded from both
          readings so the shared-vocabulary comparison is fair. The paired 95%
          intervals resample whole scores, rather than treating related staves
          as independent samples.
        </p>
        <Table
          head={[
            "Validation set",
            "Staves / scores",
            "Upstream error",
            "Public core error",
            "Change (95% CI)",
          ]}
          rows={[
            [
              "String quartet scans",
              "792 / 9",
              "14.47%",
              "5.22%",
              "−9.25 pp (−12.13, −7.23)",
            ],
            [
              "Mixed repertoire (PDMX)",
              "3,422 / 632",
              "7.44%",
              "4.69%",
              "−2.75 pp (−3.81, −1.95)",
            ],
            [
              "Voice and piano scans",
              "300 / 13",
              "5.76%",
              "2.53%",
              "−3.23 pp (−5.02, −1.71)",
            ],
          ]}
        />
        <p>
          The improvement holds across all six symbol attributes on every set.
          Pitch-and-accidental note errors fall from 9.59% to 0.92% on quartet
          scans, 7.32% to 4.47% on PDMX, and 5.93% to 1.20% on Lieder. All
          13,542 staff readings completed; failures were not filtered out.
        </p>
        <p>
          The expanded vocabulary also recognizes uncommon time signatures. On
          PDMX it identifies 5/x at the correct sequence position in 45 of 84
          cases, and 12/x in 60 of 115. Upstream identifies none of these
          explicit numerator symbols. This is an added capability; it is
          separate from the shared-symbol error improvement above.
        </p>
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="font-semibold">
            Candidate, not yet the scanner default.
          </span>{" "}
          Its error-rate differences from the pinned OTS core are inconclusive
          on all three sets. The new core&rsquo;s structured-head refits still
          need to pass their checks. The build uses published corpora, but omits
          226 unavailable historical replay rows; it is not an exact
          reconstruction of the old training run. These are previously inspected
          validation sets, not a fresh test set, and the results measure staff
          recognition rather than complete page or MusicXML correctness. OSSQ
          contains only nine scores.
        </p>
        <p>
          <a
            href="/benchmarks/public-core-vs-upstream-20260928.md"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Full three-model results and confidence intervals
          </a>{" "}
          &middot;{" "}
          <a
            href="/benchmarks/public-core-vs-upstream-20260928-protocol.md"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            Evaluation protocol
          </a>
        </p>
      </Section>

      <Section
        id="historical-recognition"
        title="Earlier deployed-model comparison"
      >
        <p>
          These earlier positional-accuracy measurements concern the deployed
          model, with older evaluation inputs. Higher is better. They use a
          paired bootstrap over staves and 95% intervals, and should not be
          mixed with the new core&rsquo;s symbol edit-error rates above.
        </p>
        <Table
          head={["Held-out set", "Staves", "HOMR", "OTS-HOMR", "Difference"]}
          rows={[
            [
              "String quartet scans",
              "792",
              "91.49",
              "95.05",
              "+3.56 pp (+2.46, +4.63)",
            ],
            [
              "Mixed repertoire (PDMX)",
              "3,349",
              "83.97",
              "88.08",
              "+4.11 pp (+3.19, +5.09)",
            ],
            [
              "Voice and piano scans",
              "300",
              "87.23",
              "94.54",
              "+7.30 pp (+4.38, +10.37)",
            ],
          ]}
        />
        <p>
          On quartet scans the gain is spread across every branch rather than
          concentrated in one: pitch 90.4&rarr;94.6, rhythm 87.5&rarr;93.1,
          accidentals 90.0&rarr;95.5, articulation 92.7&rarr;94.9, slurs
          93.2&rarr;95.3, position 95.3&rarr;96.9.
        </p>
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
          <span className="font-semibold">One caveat we keep attached.</span>{" "}
          Upstream checkpoint 426 predates the explicit numerator vocabulary;
          numerator symbols were suppressed in these comparisons. It already
          includes natural signs. These earlier figures do not attribute the
          gain to any single change or establish the new candidate&rsquo;s
          performance.
        </p>
      </Section>

      <Section
        id="cross-staff"
        title="Cross-staff agreement, the part that is actually different"
      >
        <p>
          Most OMR reads a page one staff at a time. That throws away the
          strongest evidence an ensemble score offers: the four staves of a
          quartet are playing the same bars, so their barlines have to land in
          the same places. When they don&rsquo;t, something was misread — and
          the siblings usually indicate what.
        </p>
        <p>Three mechanisms use that, in increasing order of caution:</p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="font-semibold">Rhythm reranking.</span> Where a
            staff disagrees with its siblings about where barlines fall, the
            narrowest rhythm decisions are re-decoded and the reading that best
            agrees is kept. Over 200 pages this took structural disagreements
            from 428 to 339, improved 81 of 899 systems, and made{" "}
            <span className="font-semibold">no page worse</span>.
          </li>
          <li>
            <span className="font-semibold">
              Key, time and articulation repair.
            </span>{" "}
            Where a clear majority of staves state one opening key or time
            signature and a minority states another, the minority is moved onto
            a value another staff actually read. Nothing is invented, ties are
            never broken, and a system needs at least three decoded staves
            before any of it applies.
          </li>
          <li>
            <span className="font-semibold">Verified position repair.</span>{" "}
            When a staff&rsquo;s barlines drift from the majority by a constant
            offset, that measure alone is re-decoded more thoroughly, and an
            alternative is accepted only if its barlines then match{" "}
            <em>exactly</em>. A reading that merely agrees better is rejected.
          </li>
        </ul>
        <p>
          The conservatism is deliberate. Polymetric and polytonal music is
          real, and a repair that &ldquo;fixes&rdquo; a genuine disagreement is
          worse than no repair at all.
        </p>
      </Section>

      <Section id="heads" title="The additional notation heads">
        <p>
          Standard OMR gives you pitches and rhythms and lets a notation program
          guess the rest. These heads predict the engraved notation directly, so
          what you get back resembles the page rather than a default rendering
          of its content.
        </p>
        <Table
          head={["Head", "What it gives you", "Held-out score", "Support"]}
          rows={[
            [
              "Beams",
              "The beam grouping actually printed, at every level",
              "—",
              "see note",
            ],
            [
              "Stem direction",
              "Real stem directions, not the engraver default",
              "F1 .811",
              "217,631",
            ],
            [
              "Ties",
              "Ties distinguished from slurs",
              "macro-F1 .844",
              "16,693",
            ],
            ["Slur span", "Where a slur starts and stops", "F1 .772", "3,400"],
            [
              "Slur side",
              "Whether it sits above or below",
              "macro-F1 .723",
              "3,121",
            ],
            [
              "Advance",
              "Non-trivial horizontal advance",
              "macro-F1 .751",
              "166,624",
            ],
          ]}
        />
        <p>
          <span className="font-semibold">Should you enable them?</span> For
          anything you intend to edit or engrave, yes — recovering real beaming
          and stem directions saves more manual work than it costs. If you only
          want pitches and rhythms for analysis or search, they add nothing you
          will use.
        </p>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">
            There is a seventh head for dynamics, and it is blocked.
          </span>{" "}
          It is trained, but scores macro-F1 .105 on 935 examples — barely above
          chance on a class that matters. It is prohibited at the service
          boundary rather than shipped with a warning label. We would rather
          return nothing than a confident <em>pianissimo</em> that isn&rsquo;t
          there.
        </p>
        <p>
          Dynamics are not meant to arrive this way in the end. Reading{" "}
          <em>pp</em> out of the decoder&rsquo;s hidden state asks it to infer a
          marking from the notes; the marking is{" "}
          <span className="font-semibold">printed on the page</span>, and{" "}
          <Link
            href="#lyrics"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            the text detector
          </Link>{" "}
          can see it — at 84.0 F1 on 429 held-out boxes, against the
          head&rsquo;s .105. That is the intended route, and it is not open yet:
          it needs both text detectors running in one pass, and the non-lyric
          detector currently fails at page level in a way a calibration pass
          cannot repair. Even once it opens, dynamics are expected to reach you
          as <span className="font-semibold">review suggestions</span> rather
          than automatic output — 429 examples may never support the confidence
          threshold that automatic emission requires.
        </p>
      </Section>

      <Section id="lyrics" title="Lyrics and page text">
        <p>
          A separate detector finds text regions and a recogniser reads them. On
          307 held-out pages it finds lyrics at 94.1% recall and 66.7% precision
          (78.1 F1, 3,555 boxes) — it rarely misses a syllable and sometimes
          offers one that isn&rsquo;t.
        </p>
        <p>
          Reading the syllables is harder than finding them, and it is where the
          most recent work went. A recogniser trained on rendered text read
          88.7% of rendered syllables exactly and only{" "}
          <span className="font-semibold">13.0%</span> of scanned ones.
          Retrained on syllables cut from real scans, that reached{" "}
          <span className="font-semibold">51.6%</span> exact with character
          error falling from 61% to 20%, measured on syllables from scores the
          model never saw. Most of what remains is typography rather than
          misreading — accents, and curly versus straight apostrophes.
        </p>
        <p>
          The same detector finds non-lyric text — dynamics at 84.0 F1 (429
          boxes) and measure numbers at 84.1 (78) on the same held-out pages.
          Both are far better read off the page than inferred from the notes,
          which is why they are the intended source for{" "}
          <Link
            href="#heads"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            dynamics
          </Link>{" "}
          rather than the notation head.
        </p>
        <p>
          Two limits keep that from shipping today. A single pass detects either
          lyrics or non-lyric text, not both — and the non-lyric detector, on
          re-evaluation at full-page level, returns the whole page as one
          enormous region. That is a detector failure, not a threshold that
          wants tuning: calibrating it would calibrate noise. Lyrics run through
          the identical code path and behave, which points at the checkpoint
          rather than the plumbing, but that is evidence and not yet proof.
        </p>
      </Section>

      <Section id="beaming" title="Where beaming actually differs" wide>
        <p className="max-w-5xl">
          Most beaming is not a choice. Given a metre and a run of short notes,
          a deterministic rule reproduces what an engraver would write, and any
          program can do that without looking at the page. So the interesting
          question is not how often a model agrees with the engraving — it is
          what the disagreements are made of.
        </p>
        <p className="max-w-5xl">
          Measured over 122 OpenScore string quartets, 823,217 notes carrying at
          least one flag: the rule already matches the engraving on{" "}
          <span className="font-semibold">81.8%</span> of them. Below is every
          way the remaining 149,459 differ, largest first, with one real example
          of each.
        </p>
        <p className="max-w-5xl text-slate-600 dark:text-slate-400">
          In each comparison the notes are identical and only the beams move: on
          the left what the rule produces, on the right what the engraver wrote.
        </p>
        <BeamCaseList />
        <p className="mt-6 max-w-5xl">
          Two of these are worth singling out. The{" "}
          <span className="font-semibold">hooks</span> case is not visual
          information at all — which of a flag or a partial beam applies follows
          from the durations, so a rule that writes a flag there simply has not
          implemented that part of the rule. And a{" "}
          <span className="font-semibold">beam running over a rest</span> is the
          opposite: the rule cannot express it under any circumstances, because
          a rest ends a group by construction. That one is ours alone.
        </p>
      </Section>

      <Section id="examples" title="Worked examples" wide>
        <p className="max-w-5xl">
          Two galleries, both on whole pages that no development step used. The
          first puts upstream homr and OTS-HOMR on the same pages and shows
          every page where they differ, including how little separates them on
          clean engravings. The second shows what the review-assisted lyrics,
          directions and dynamics add to a scanned page.
        </p>
        <p className="max-w-5xl text-slate-600 dark:text-slate-400">
          The comparisons open in the score editor, the same one the scanner
          review tools use, so you can page through a system at a time. The
          numbers above come from staff-level benchmarks; these are whole pages.
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
        <p>
          Every scanner result is a draft. That is not modesty about this engine
          in particular — it is true of all OMR, and the review tools exist
          because of it.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <span className="font-semibold">
              It cannot be told what it is reading.
            </span>{" "}
            The checks that compare a page against an expected instrumentation
            are built and tested, but there is no way to supply one yet. For a
            quartet — where the parts and clefs are known before recognition
            starts — this is the most obviously useful thing still missing.
          </li>
          <li>
            <span className="font-semibold">
              Cross-staff context decoding does not ship.
            </span>{" "}
            The most general of the cross-staff mechanisms, which attends across
            a system&rsquo;s voices rather than reranking rhythm alone, is built
            but not enabled: in its most recent training run it moved the
            model&rsquo;s own loss by about 0.6%, and did so unstably.
          </li>
          <li>
            <span className="font-semibold">Our evaluation has a floor.</span> A
            pair is admitted to the evaluation set when two independent methods
            agree on which bars a crop contains. Both can agree and both be
            wrong; we have a confirmed example. Nothing currently checks each
            voice&rsquo;s label separately, so the reported numbers carry an
            unmeasured error of this kind.
          </li>
        </ul>
      </Section>

      <Section id="history" title="How it was built">
        <p>
          The design was accepted in August 2026 with a deliberate constraint:
          improve ensemble transcription{" "}
          <em>without building a quartet-only model</em>. Every new interface is
          optional and variable-staff, the pretrained visual encoder and decoder
          are preserved rather than retrained from scratch, and new heads are
          trained against a frozen core before anything is tuned jointly.
        </p>
        <p>
          The most instructive part of the project was not a modelling result.
          It was discovering that our training data was wrong.
        </p>
        <p>
          The original corpus paired each scanned system with symbolic music by
          page and system index — across editions whose pagination differs.
          Every guard passed: a record existed, part counts matched, tokens
          parsed. The pairs were still wrong, and the failure was invisible in
          aggregate because it looked like ordinary model error.
        </p>
        <p>
          The diagnostic that settled it was qualitative. A reading matched the
          scan exactly while disagreeing with its assigned target — which is a
          label failure, not a model failure. A 900-staff audit put numbers on
          it:
        </p>
        <Table
          head={["Measure", "Before", "After rebuild"]}
          rows={[
            ["Staves losing >50 accuracy points", "56.7%", "7.9%"],
            ["Mean accuracy on scans", "46.8", "89.9"],
            ["Median per-staff drop", "76.7", "0.0"],
          ]}
        />
        <p>
          The rebuild aligns each crop to its bars twice, by independent methods
          — one counting bars geometrically, one asking which crop contains each
          labelled bar — and admits a pair to the <em>evaluation</em> set only
          where the two agree. The second method is derived from a recogniser,
          so it is firewalled out of evaluation entirely: filtering an
          evaluation set by agreement with a model measures the model against
          itself.
        </p>
        <p>
          Then human review overturned four automated judgements, and{" "}
          <span className="font-semibold">
            all four had erred in the same direction
          </span>
          : discarding good data. Rejecting pairs on disagreement was wrong 32
          times out of 33. &ldquo;No content found&rdquo; turned out to mean a
          rest-heavy system whose rests weren&rsquo;t being counted — wrong 30
          times out of 30. A pipeline that errs conservatively looks healthy
          from the inside, which is the reason review happened at all.
        </p>
      </Section>

      <Section id="rules" title="What we learned">
        <p>
          Rules this project paid for, kept here because they cost real time and
          generalise past this model.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            A benchmark built from labels you rebuilt yourself measures your
            labels as much as your model.
          </li>
          <li>
            Never recompute an evaluation target with a model whose score will
            be reported against it.
          </li>
          <li>
            Do not trust unit tests to prove export. Our first beam
            implementation predicted beams correctly and discarded them on the
            way out.
          </li>
          <li>
            Do not report scores for rare classes without their support
            alongside.
          </li>
          <li>
            An automated pipeline that errs conservatively looks healthy from
            the inside.
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
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            homr
          </a>{" "}
          by Christian Liebhardt and contributors, and inherits its AGPL-3.0
          licence. The recognition improvements described here are ours; the
          visual encoder and autoregressive decoder they build on are
          upstream&rsquo;s, and we preserved them deliberately rather than
          retraining from scratch.
        </p>
        <p>
          Training corpora are built from{" "}
          <a
            href="https://github.com/OpenScore/StringQuartets"
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            OpenScore String Quartets
          </a>
          ,{" "}
          <a
            href="https://github.com/OpenScore/Lieder"
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            OpenScore Lieder
          </a>{" "}
          and scans from IMSLP.
        </p>
        <p className="text-slate-600 dark:text-slate-400">
          Every figure on this page is a held-out measurement with its support
          stated. Where this page and homr&rsquo;s own{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">
            docs/PIPELINE.md
          </code>{" "}
          disagree, that document is the authority.
        </p>
      </Section>

      <div className="mt-12 border-t border-slate-200 pt-6 dark:border-slate-700">
        <Link
          href="/scanner"
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          &larr; Back to the scanner
        </Link>
      </div>
    </main>
  );
}
