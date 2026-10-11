import Link from "next/link";
import FeatureShowcase, { type ShowcaseFeature } from "./feature-showcase";
import {
  PUBLIC_CHANGE_REVIEW_ID,
  PUBLIC_SCANNER_JOB_ID,
} from "../lib/public-examples";

const FAURE_SCORE_URL =
  "https://raw.githubusercontent.com/OpenScore/StringQuartets/refs/heads/main/scores/Faur%C3%A9,_Gabriel/String_Quartet,_Op.121/sq7358708.mxl";
const BEETHOVEN_SCORE_URL =
  "https://raw.githubusercontent.com/DCMLab/beethoven_piano_sonatas/main/MS3/01-1.mscx";

function scoreExampleHref(path: "/player" | "/score-editor/index.html", scoreUrl: string) {
  return `${path}?${new URLSearchParams({ score: scoreUrl }).toString()}`;
}

const platformFeatures: ShowcaseFeature[] = [
  {
    id: "versioned",
    title: "Versioned Sources",
    body: "Every source has full revision history with branching workflows to manage community editorial work.",
    href: "/works/1148359",
    linkLabel: "Open Example Versioned Source",
    media: {
      light: "/images/features/versioned-sources-light.webm",
      dark: "/images/features/versioned-sources-dark.webm",
    },
  },
  {
    id: "editor",
    title: "Score Editor",
    body: "Open and edit scores directly in the browser to reduce context switching between tools.",
    href: scoreExampleHref("/score-editor/index.html", FAURE_SCORE_URL),
    linkLabel: "Open Example in Score Editor",
    media: { light: "/images/features/score-editor-light.webm" },
  },
  {
    id: "player",
    title: "Score Player",
    body: "Integrated score-following audio player.",
    href: scoreExampleHref("/player", BEETHOVEN_SCORE_URL),
    linkLabel: "Open Example in Score Player",
    media: {
      light: "/images/features/player-light.webm",
      dark: "/images/features/player-dark.webm",
    },
  },
  {
    id: "scanner",
    title: "Scanner",
    body: "Turn a photo or PDF of printed sheet music into editable MusicXML, review the pages, then open the result in the Score Editor.",
    href: `/scanner/${PUBLIC_SCANNER_JOB_ID}`,
    linkLabel: "Open Example Scan",
    media: {
      light: "/images/features/scanner-light.webm",
      dark: "/images/features/scanner-dark.webm",
    },
  },
  {
    id: "catalogue",
    title: "Catalogue",
    body: "Search and browse works by title, composer and catalogue number.",
    href: "/catalogue",
    linkLabel: "Explore the Catalogue",
    media: {
      light: "/images/features/catalogue-light.webm",
      dark: "/images/features/catalogue-dark.webm",
    },
  },
  {
    id: "review",
    title: "Change Reviews",
    body: "Get feedback on each changed line in the Visual Score Diff and resolve comments across multiple rounds of revisions.",
    href: `/change-reviews/${PUBLIC_CHANGE_REVIEW_ID}`,
    linkLabel: "Open Example Change Review",
    media: {
      light: "/images/features/change-review-light.webm",
      dark: "/images/features/change-review-dark.webm",
    },
  },
];

const whyDigitize = [
  {
    title: "Performance prep",
    body: "Add fingerings, bowings, dynamics and rehearsal notes to beautifully engraved parts.",
  },
  {
    title: "Arranging and transposing",
    body: "Convert to different clefs, keys, vocal ranges or instrumentations.",
  },
  {
    title: "Reusable music data",
    body: "One engraving works across practice apps, analysis tools, publishing and performance.",
  },
  {
    title: "Study and research",
    body: "Structured score data enables computational analysis and reproducible musicology.",
  },
  {
    title: "Faster editorial cycles",
    body: "Versioned, diffable scores let reviewers focus on musical intent, not re-checking whole documents.",
  },
  {
    title: "Transparent collaboration",
    body: "Branches, approvals and revision metadata show who changed what, why, and when.",
  },
];

const steps = [
  {
    n: "1",
    title: "Find a work",
    body: "Search the catalogue by title, composer or catalogue number.",
  },
  {
    n: "2",
    title: "Open or edit it",
    body: "Play it, or edit the score right in your browser. Nothing to install.",
  },
  {
    n: "3",
    title: "Contribute back",
    body: "Upload a revision or scan, then get it reviewed by the community.",
  },
];

const searchExamples = ["Beethoven sonata", "Fauré quartet", "Bach suite"];

const scannerEnabled = process.env.NEXT_PUBLIC_SCANNER_ENABLED === "true";

const sectionClass =
  "rounded-xl border border-slate-200 bg-white p-6 shadow-sm md:p-8 dark:border-slate-800 dark:bg-slate-900/60";
const disclosureClass =
  "rounded-xl border border-slate-200 bg-white px-6 py-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60";
const summaryClass =
  "cursor-pointer font-[var(--font-heading)] text-xl font-semibold marker:text-slate-400";
const quietLinkClass =
  "font-medium text-emerald-700 hover:underline dark:text-emerald-400";

export const metadata = {
  title: "Welcome | OurTextScores",
  description: "OurTextScores platform overview and why digitization matters.",
};

export default function WelcomePage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pb-16 pt-12">
        <header className="rounded-2xl bg-gradient-to-br from-emerald-50 via-cyan-50 to-sky-100 p-8 shadow-sm ring-1 ring-slate-900/5 md:p-12 dark:from-slate-900 dark:via-slate-900 dark:to-emerald-950/60 dark:ring-white/10">
          <h1 className="font-[var(--font-heading)] text-4xl leading-tight md:text-5xl">
            Open, collaborative, editable music scores
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-700 dark:text-slate-300">
            Find a public-domain score, fix it in your browser, and share the improvement.
          </p>

          <form action="/catalogue" method="get" role="search" className="mt-8 flex max-w-2xl flex-col gap-3 sm:flex-row">
            <input
              type="search"
              name="q"
              aria-label="Search the catalogue"
              placeholder="Search by title, composer or catalogue number"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="submit"
              className="rounded-lg bg-emerald-600 px-6 py-3 text-base font-semibold text-white transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
            >
              Search
            </button>
          </form>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
            Try:{" "}
            {searchExamples.map((example, idx) => (
              <span key={example}>
                {idx > 0 && " · "}
                <Link href={`/catalogue?${new URLSearchParams({ q: example }).toString()}`} className={quietLinkClass}>
                  {example}
                </Link>
              </span>
            ))}
          </p>

          <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
            <Link href="/catalogue" className={quietLinkClass}>
              Browse the catalogue
            </Link>
            {scannerEnabled && (
              <>
                {" · "}
                <Link href="/scanner" className={quietLinkClass}>
                  Scan sheet music
                </Link>
              </>
            )}
            {" · "}
            <Link href="/upload" className={quietLinkClass}>
              Upload a score
            </Link>
            {" · "}
            <Link href="/score-editor" className={quietLinkClass}>
              Open the editor
            </Link>
          </p>
        </header>

        <section aria-labelledby="how-it-works" className={sectionClass}>
          <h2 id="how-it-works" className="font-[var(--font-heading)] text-2xl">
            How it works
          </h2>
          <ol className="mt-5 grid gap-6 md:grid-cols-3">
            {steps.map((step) => (
              <li key={step.n} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
                >
                  {step.n}
                </span>
                <div>
                  <h3 className="font-semibold">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="see-it" className={sectionClass}>
          <h2 id="see-it" className="mb-5 font-[var(--font-heading)] text-2xl">
            See it in action
          </h2>
          <FeatureShowcase features={platformFeatures} />
        </section>

        <section aria-labelledby="get-involved" className={sectionClass}>
          <h2 id="get-involved" className="font-[var(--font-heading)] text-2xl">
            Get involved
          </h2>
          <ul className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <li>
              <Link href="/upload" className={quietLinkClass}>Upload a source</Link>
              <span className="text-slate-600 dark:text-slate-400"> for an IMSLP work, ideally with its reference PDF.</span>
            </li>
            <li>
              <Link href="/catalogue" className={quietLinkClass}>Improve an existing score</Link>
              <span className="text-slate-600 dark:text-slate-400"> with a revision, a rating or a comment.</span>
            </li>
            <li>
              <Link href="/projects" className={quietLinkClass}>Join a project</Link>
              <span className="text-slate-600 dark:text-slate-400"> to coordinate with other editors.</span>
            </li>
            <li>
              <Link href="https://discord.gg/T3BuWeWGqt" target="_blank" rel="noreferrer" className={quietLinkClass}>
                Join us on Discord
              </Link>
              <span className="text-slate-600 dark:text-slate-400"> to ask questions and share progress.</span>
            </li>
            <li className="sm:col-span-2">
              <span className="text-slate-600 dark:text-slate-400">Report bugs or send PRs: </span>
              <Link href="https://github.com/OurTextScores/OurTextScores/" target="_blank" rel="noreferrer" className={quietLinkClass}>
                Website repo
              </Link>
              {" · "}
              <Link href="https://github.com/OurTextScores/OTS_WebEditor/" target="_blank" rel="noreferrer" className={quietLinkClass}>
                Score editor repo
              </Link>
            </li>
          </ul>
        </section>

        <details className={disclosureClass}>
          <summary className={summaryClass}>Why digitize?</summary>
          <dl className="mt-4 grid gap-4 md:grid-cols-2">
            {whyDigitize.map((entry) => (
              <div key={entry.title}>
                <dt className="font-semibold">{entry.title}</dt>
                <dd className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{entry.body}</dd>
              </div>
            ))}
          </dl>
        </details>

        <details className={disclosureClass}>
          <summary className={summaryClass}>IMSLP and copyright</summary>
          <div className="mt-4 text-sm leading-7 text-slate-700 dark:text-slate-300">
            <p>
              Every work on OurTextScores is linked to an{" "}
              <Link href="https://imslp.org" className={`${quietLinkClass} underline`}>
                IMSLP
              </Link>{" "}
              page. Only reference PDFs hosted on IMSLP are allowed, ensuring that the underlying
              compositions are public-domain or legally available in Canada where OurTextScores is hosted.
            </p>
            <p className="mt-3 text-slate-600 dark:text-slate-400">
              Public-domain status varies by country. If you are outside Canada, check the IMSLP page for
              your jurisdiction before downloading. Note also that an engraving may carry a separate
              copyright from the underlying composition.
            </p>
          </div>
        </details>
      </div>
    </main>
  );
}
