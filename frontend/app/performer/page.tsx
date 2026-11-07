import Link from "next/link";
import { EXAMPLE_SCORE_URL, performHref } from "../lib/performer-links";

const features: { title: string; body: string }[] = [
  {
    title: "Page turns, hands free",
    body: "Turn with a Bluetooth page-turning pedal or a tap. Half-page turns show the top of the next page above the bottom of this one, so you read ahead before the turn.",
  },
  {
    title: "Laid out for your screen",
    body: "The score is engraved for the iPad you hold, at the size you choose, in portrait or landscape; or keep the pages exactly as engraved.",
  },
  {
    title: "Repeats made easy",
    body: "Tap a repeat sign, D.C. or coda to go where the music goes next, or switch on Play-through to see the repeats written out in playing order.",
  },
  {
    title: "Mark it up",
    body: "Draw with the Apple Pencil, highlight, type, or stamp fingerings, bowings, breath marks and dynamics in the score's own music font. Marks stay on their notes when the layout changes; undo, history and named checkpoints keep them safe.",
  },
  {
    title: "Setlists, offline",
    body: "Put pieces in order and pedal from one to the next. Make a setlist available offline and perform in airplane mode: the app and the scores are kept on the iPad.",
  },
  {
    title: "From rehearsal to the score",
    body: "After the rehearsal, review your stamps in the Score Editor and engrave them into the score as real notation; the stamp then gives way to the engraved marking.",
  },
];

const installSteps = [
  "Open Performer mode in Safari on your iPad (iPadOS 18.4 or later).",
  "Tap Share, then Add to Home Screen.",
  "Open it from the Home Screen once while online: it is then saved on the iPad and opens offline.",
];

const sectionClass =
  "rounded-xl border border-slate-200 bg-white p-6 shadow-sm md:p-8 dark:border-slate-800 dark:bg-slate-900/60";
const primaryButtonClass =
  "inline-flex items-center rounded-lg bg-emerald-600 px-5 py-3 text-base font-semibold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400";
const secondaryButtonClass =
  "inline-flex items-center rounded-lg border border-slate-300 bg-white px-5 py-3 text-base font-semibold text-slate-800 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800";
const quietLinkClass = "font-medium text-emerald-700 hover:underline dark:text-emerald-400";

export const metadata = {
  title: "Performer mode | OurTextScores",
  description:
    "Perform from OurTextScores scores on an iPad: page turns with a pedal, half-page turns, repeats, annotations, setlists and offline use.",
};

export default function PerformerPage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pb-16 pt-12">
        <header className="rounded-2xl bg-gradient-to-br from-emerald-50 via-cyan-50 to-sky-100 p-8 shadow-sm ring-1 ring-slate-900/5 md:p-12 dark:from-slate-900 dark:via-slate-900 dark:to-emerald-950/60 dark:ring-white/10">
          <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            New
          </p>
          <h1 className="mt-2 font-[var(--font-heading)] text-4xl leading-tight md:text-5xl">Performer mode</h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-700 dark:text-slate-300">
            Perform from OurTextScores scores on your iPad: engraved for your screen, turned with a pedal, marked up
            with the Pencil, and ready offline.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={performHref()} className={primaryButtonClass} data-testid="performer-open">
              Open Performer mode
            </a>
            <a
              href={performHref({ score: EXAMPLE_SCORE_URL })}
              className={secondaryButtonClass}
              data-testid="performer-example"
            >
              Try it with a Beethoven sonata
            </a>
          </div>
          <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
            <a href={performHref({ guide: true })} className={quietLinkClass}>
              How to use it
            </a>
            {" · "}
            <Link href="/catalogue" className={quietLinkClass}>
              Find a score to perform
            </Link>
          </p>
        </header>

        <section aria-labelledby="features" className={sectionClass}>
          <h2 id="features" className="font-[var(--font-heading)] text-2xl">
            Made for the stage
          </h2>
          <ul className="mt-5 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <li key={feature.title}>
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{feature.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="install" className={sectionClass}>
          <h2 id="install" className="font-[var(--font-heading)] text-2xl">
            Install it on your iPad
          </h2>
          <ol className="mt-5 list-decimal space-y-2 pl-5 text-slate-700 dark:text-slate-300">
            {installSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
            Your marks and setlists stay on your iPad. Export your marks now and then to keep a copy.
          </p>
        </section>

        <section aria-labelledby="from-a-score" className={sectionClass}>
          <h2 id="from-a-score" className="font-[var(--font-heading)] text-2xl">
            Any score in the catalogue
          </h2>
          <p className="mt-3 text-slate-700 dark:text-slate-300">
            Every source in the{" "}
            <Link href="/catalogue" className={quietLinkClass}>
              catalogue
            </Link>{" "}
            has a <strong>Perform</strong> button that opens it in Performer mode. In the Score Editor, File ▸ Open in
            Performance Mode takes the score you are editing, unsaved changes included. You can also open a MusicXML,
            MuseScore, MEI or MNX file from your iPad.
          </p>
        </section>
      </div>
    </main>
  );
}
