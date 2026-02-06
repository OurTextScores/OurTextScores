import Link from "next/link";

const platformFeatures = [
  {
    title: "Versioned Sources",
    body: "Every source has revision history, branching workflows, and reviewable metadata so editorial work stays traceable over time.",
  },
  {
    title: "Visual Musical Diff",
    body: "Compare revisions at the score level and in canonical text views to quickly inspect meaningful notation changes.",
  },
  {
    title: "Integrated Score Editor",
    body: "Open and inspect scores directly in the browser to reduce context switching between tools.",
  },
  {
    title: "Catalogue Discovery",
    body: "Search and browse works by title, composer and catalogue number.",
  },
  {
    title: "Project Workspaces",
    body: "Coordinate contributors, track project-linked sources, and manage collaborative progress in dedicated project pages.",
  },
  {
    title: "Downloadable Artifacts",
    body: "Access MusicXML, MuseScore (MSCX) and PDFs versions from each revision for practical reuse.",
  },
];

const whyDigitize = [
  {
    title: "Performance Prep",
    body: "Performers can adapt and annotate materials - add your own fingerings, bowings, dynamics, rehearsal notes with beautiful engraving.",
  },
  {
    title: "Arranging and Transposing",
    body: "Convert to different clefs, keys or vocal ranges.",
  },
  {
    title: "Reusable Music Data",
    body: "Digital formats make one engraving useful across practice apps, analysis tools, publishing workflows, and performance prep.",
  },
  {
    title: "Study and Research",
    body: "Structured score data enables computational analysis, cross-work comparisons, easy score annotation and reproducible musicological workflows.",
  },
  {
    title: "Faster Editorial Cycles",
    body: "When scores are versioned and diffable, reviewers can focus on musical intent instead of manually re-checking entire documents.",
  },
  {
    title: "Transparent Collaboration",
    body: "Branching, approvals, and revision metadata make it clear who changed what, why it changed, and when it was accepted.",
  },
];

const waysToContribute = [
  {
    title: "Upload a Source",
    body: "Start a source for an IMSLP work. Including a matching IMSLP reference PDF is especially helpful.",
  },
  {
    title: "Submit a New Revision",
    body: "Improve an existing source with corrections, clearer engraving, or better musical detail.",
  },
  {
    title: "Rate a Source",
    body: "Use ratings to highlight reliable sources and help others choose what to use first.",
  },
  {
    title: "Leave Constructive Comments",
    body: "Share specific, actionable feedback so editors can improve quickly.",
  },
  {
    title: "Flag Mismatched Sources",
    body: "Report uploads that do not correspond to the linked IMSLP work.",
  },
  {
    title: "Join a Project",
    body: "Contribute inside project workspaces to coordinate priorities and progress with other editors.",
  },
  {
    title: "Report Bugs or Send PRs",
    body: "Open issues for the website or score editor, and submit pull requests when you can.",
  },
];

const quickLinks = [
  { href: "/catalogue", label: "Browse Catalogue" },
  { href: "/works/upload", label: "Save IMSLP Work" },
  { href: "/upload", label: "Upload New Source" },
  { href: "/projects", label: "Explore Projects" },
  { href: "/score-editor", label: "Open Score Editor" },
];

export const metadata = {
  title: "Welcome | OurTextScores",
  description: "OurTextScores platform overview and why digitization matters.",
};

export default function WelcomePage() {
  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f0f7ff_0%,#e0ecff_55%,#cfddf4_100%)] text-slate-900 dark:bg-[linear-gradient(180deg,#020617_0%,#0b1220_55%,#111a2d_100%)] dark:text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-14 pt-12">
        <header className="rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#ffffff_0%,#ecf5ff_100%)] p-8 shadow-[0_12px_40px_rgba(21,53,94,0.12)] dark:border-slate-700 dark:bg-[linear-gradient(135deg,#0f172a_0%,#0b1a33_100%)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-600 dark:text-slate-300">Welcome to OurTextScores</p>
          <h1 className="mt-2 font-[var(--font-heading)] text-4xl leading-tight md:text-5xl">
            Open, Collaborative, Editable Music Scores
          </h1>
          <p className="mt-6 max-w-4xl text-sm leading-7 text-slate-700 dark:text-slate-200">
            OurTextScores is a community platform for creating, reviewing, and publishing structured score data.
            We combine source uploads, revision history, visual diffs, and project-level collaboration so contributors
            can build reliable digital editions with clear provenance.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {quickLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md border border-cyan-300 bg-white/80 px-4 py-2 text-sm font-semibold text-cyan-800 hover:bg-white dark:border-cyan-700 dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-slate-800"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </header>

        <section className="rounded-xl border border-slate-300 bg-white/90 p-8 shadow-sm dark:border-slate-700 dark:bg-slate-900/80">
          <h2 className="font-[var(--font-heading)] text-3xl">Platform Features</h2>
          <p className="mt-4 text-sm leading-7 text-slate-700 dark:text-slate-200">
            OurTextScores is designed for practical editorial workflows: ingest source files, generate standardized
            derivatives, compare revisions, and coordinate contributions across works and projects.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {platformFeatures.map((feature) => (
              <article key={feature.title} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/70">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">{feature.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-white/90 p-8 shadow-sm dark:border-slate-700 dark:bg-slate-900/80">
          <h2 className="font-[var(--font-heading)] text-3xl">IMSLP Integration</h2>
          <div className="mt-4 space-y-4 text-sm leading-7 text-slate-700 dark:text-slate-200">
            <p>
              All OurTextScores works are associated with an{" "}
              <Link
                href="https://imslp.org"
                className="font-medium text-cyan-700 underline decoration-cyan-400 underline-offset-2 hover:text-cyan-800 dark:text-cyan-300 dark:decoration-cyan-500 dark:hover:text-cyan-200"
              >
                International Music Score Library Project (IMSLP)
              </Link>
              {" "}work. Only reference PDFs from the IMSLP page are allowed which ensures they are public domain/legal in Canada where OurTextScores is hosted. Users may upload engraved scores with a variety of copyright licenses for these public domain works.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-white/90 p-8 shadow-sm dark:border-slate-700 dark:bg-slate-900/80">
          <h2 className="font-[var(--font-heading)] text-3xl">Why Digitize?</h2>
          <p className="mt-4 space-y-4 text-sm leading-7 text-slate-700 dark:text-slate-200">
            Digital scores are more convenient and versatile than PDF scans.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {whyDigitize.map((entry) => (
              <article key={entry.title} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/70">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">{entry.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{entry.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-white/90 p-8 shadow-sm dark:border-slate-700 dark:bg-slate-900/80">
          <h2 className="font-[var(--font-heading)] text-3xl">Ways to Contribute</h2>
          <p className="mt-4 text-sm leading-7 text-slate-700 dark:text-slate-200">
            Every contribution helps make this catalogue more accurate, usable, and collaborative.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {waysToContribute.map((entry) => (
              <article key={entry.title} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/70">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">{entry.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{entry.body}</p>
                {entry.title === "Report Bugs or Send PRs" ? (
                  <p className="mt-3 text-sm leading-6 text-slate-700 dark:text-slate-300">
                    <Link
                      href="https://github.com/OurTextScores/OurTextScores/"
                      className="font-medium text-cyan-700 underline decoration-cyan-400 underline-offset-2 hover:text-cyan-800 dark:text-cyan-300 dark:decoration-cyan-500 dark:hover:text-cyan-200"
                    >
                      Website issues and PRs
                    </Link>
                    {" "}and{" "}
                    <Link
                      href="https://github.com/OurTextScores/OurTextScores/"
                      className="font-medium text-cyan-700 underline decoration-cyan-400 underline-offset-2 hover:text-cyan-800 dark:text-cyan-300 dark:decoration-cyan-500 dark:hover:text-cyan-200"
                    >
                      score editor issues and PRs
                    </Link>
                    .
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
