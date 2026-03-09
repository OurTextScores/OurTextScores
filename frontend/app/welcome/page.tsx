import Link from "next/link";

const platformFeatures: Array<{
  title: string;
  body: string;
  media?: { light: string; dark?: string };
}> = [
  {
    title: "Versioned Sources",
    body: "Every source has full revision history with branching workflows to manage community editorial work.",
    media: { light: "/images/features/versioned-sources-light.webm", dark: "/images/features/versioned-sources-dark.webm" },
  },
  {
    title: "Visual Musical Diff",
    body: "Compare revisions side-by-side at the score level to quickly inspect meaningful notation changes.",
    media: { light: "/images/features/visual-diff-light.webm" },
  },
  {
    title: "Integrated Score Editor",
    body: "Open and edit scores directly in the browser to reduce context switching between tools.",
    media: { light: "/images/features/score-editor-light.webm" },
  },
  {
    title: "Catalogue Discovery",
    body: "Search and browse works by title, composer and catalogue number.",
    media: { light: "/images/features/catalogue-light.webm", dark: "/images/features/catalogue-dark.webm" },
  },
  {
    title: "Project Workspaces",
    body: "Coordinate contributors, track project-linked sources, and manage collaborative progress in dedicated project pages.",
    media: { light: "/images/features/projects-light.webm", dark: "/images/features/projects-dark.webm" },
  },
  {
    title: "Change Review Workflows",
    body: "Get feedback on each changed line in the Visual Score Diff and resolve comments across multiple rounds of revisions.",
    media: { light: "/images/features/change-review-light.webm", dark: "/images/features/change-review-dark.webm" },
  },
];

const whyDigitize = [
  {
    title: "Performance Prep",
    body: "Performers can adapt and annotate materials \u2014 add fingerings, bowings, dynamics, and rehearsal notes with beautiful engraving.",
  },
  {
    title: "Arranging and Transposing",
    body: "Convert to different clefs, keys, vocal ranges, or instrumentations.",
  },
  {
    title: "Reusable Music Data",
    body: "Digital formats make one engraving useful across practice apps, analysis tools, publishing workflows, and performance prep.",
  },
  {
    title: "Study and Research",
    body: "Structured score data enables computational analysis, cross-work comparisons, score annotation, and reproducible musicology workflows.",
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
    body: "Create a new source for an IMSLP work. Including a matching IMSLP reference PDF is especially helpful.",
  },
  {
    title: "Submit a New Revision",
    body: "Improve an existing source with corrections or an alternative edition.",
  },
  {
    title: "Rate a Source",
    body: "Use ratings to highlight reliable sources and help others choose what to use first.",
  },
  {
    title: "Leave a Comment",
    body: "Share feedback about a transcription so users know what to expect, or for editors to know what to improve.",
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
    body: "Open issues or submit pull requests for the website or score editor.",
  },
  {
    title: "Join us on Discord",
    body: "Ask questions, share progress, and connect with other contributors.",
  },
];

const quickLinks = [
  { href: "/catalogue", label: "Browse Catalogue", icon: "≡" },
  { href: "/works/upload", label: "Save IMSLP Work", icon: "+" },
  { href: "/upload", label: "Upload New Source", icon: "↑" },
  { href: "/projects", label: "Explore Projects", icon: "▦" },
  { href: "/score-editor", label: "Open Score Editor", icon: "✎" },
];

export const metadata = {
  title: "Welcome | OurTextScores",
  description: "OurTextScores platform overview and why digitization matters.",
};

export default function WelcomePage() {
  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f0f7ff_0%,#e0ecff_55%,#cfddf4_100%)] text-slate-900 dark:bg-[linear-gradient(180deg,#020617_0%,#0b1220_55%,#111a2d_100%)] dark:text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-14 pt-12">
        <header className="rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#ecfdf5_0%,#cffafe_40%,#dbeafe_100%)] p-8 shadow-[0_12px_40px_rgba(21,53,94,0.12)] dark:border-cyan-900/60 dark:bg-[linear-gradient(135deg,#0d9488,#0e7490,#0f172a,#134e4a,#0d9488)] dark:bg-[length:300%_300%] dark:[animation:hero-gradient-shift_12s_ease_infinite] dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-600 dark:text-slate-300">Welcome to OurTextScores</p>
          <h1 className="mt-2 font-[var(--font-heading)] text-4xl leading-tight md:text-5xl">
            Open, Collaborative, Editable Music Scores
          </h1>
          <p className="mt-6 max-w-4xl text-sm leading-7 text-slate-700 dark:text-slate-200">
            OurTextScores is a platform for collaborative score transcription.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {quickLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md border border-cyan-300 bg-white/80 px-4 py-2 text-sm font-semibold text-cyan-800 transition-all duration-150 hover:-translate-y-px hover:bg-white hover:shadow-md dark:border-cyan-700 dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-slate-800 dark:hover:shadow-lg dark:hover:shadow-cyan-950/30"
              >
                <span aria-hidden="true">{item.icon} </span>
                {item.label}
              </Link>
            ))}
          </div>
        </header>

        <section className="rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#ecfdf5_0%,#cffafe_40%,#dbeafe_100%)] p-8 shadow-sm dark:border-cyan-900/60 dark:bg-[linear-gradient(135deg,#0d9488,#0e7490,#0f172a,#134e4a,#0d9488)] dark:bg-[length:300%_300%] dark:[animation:hero-gradient-shift_12s_ease_infinite] dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <h2 className="font-[var(--font-heading)] text-3xl">Why Digitize?</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {whyDigitize.map((entry) => (
              <article key={entry.title} className="rounded-lg border border-slate-200 bg-white p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-slate-600 dark:hover:shadow-lg dark:hover:shadow-slate-900/40">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">{entry.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{entry.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#ecfdf5_0%,#cffafe_40%,#dbeafe_100%)] p-8 shadow-sm dark:border-cyan-900/60 dark:bg-[linear-gradient(135deg,#0d9488,#0e7490,#0f172a,#134e4a,#0d9488)] dark:bg-[length:300%_300%] dark:[animation:hero-gradient-shift_12s_ease_infinite] dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <h2 className="font-[var(--font-heading)] text-3xl">Platform Features</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {platformFeatures.map((feature, idx) => {
              // Left column (even index) expands right; right column (odd) expands left
              const origin = idx % 2 === 0 ? "top left" : "top right";
              return (
                <article key={feature.title} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/70">
                  <h3 className="font-semibold text-slate-900 dark:text-slate-100">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{feature.body}</p>
                  {feature.media && (
                    <div className="relative mt-3">
                      <video
                        src={feature.media.light}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className={`w-full rounded border border-slate-200 transition-transform duration-300 ease-out hover:scale-[2] hover:relative hover:z-50 hover:shadow-2xl dark:border-slate-700 ${feature.media.dark ? "dark:hidden" : ""}`}
                        style={{ transformOrigin: origin }}
                      />
                      {feature.media.dark && (
                        <video
                          src={feature.media.dark}
                          autoPlay
                          loop
                          muted
                          playsInline
                          className="hidden w-full rounded border border-slate-700 transition-transform duration-300 ease-out hover:scale-[2] hover:relative hover:z-50 hover:shadow-2xl dark:block"
                          style={{ transformOrigin: origin }}
                        />
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#ecfdf5_0%,#cffafe_40%,#dbeafe_100%)] p-8 shadow-sm dark:border-cyan-900/60 dark:bg-[linear-gradient(135deg,#0d9488,#0e7490,#0f172a,#134e4a,#0d9488)] dark:bg-[length:300%_300%] dark:[animation:hero-gradient-shift_12s_ease_infinite] dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <h2 className="font-[var(--font-heading)] text-3xl">IMSLP Integration</h2>
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm leading-7 text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
            <p>
              Every work on OurTextScores is linked to an{" "}
              <Link
                href="https://imslp.org"
                className="font-medium text-cyan-700 underline decoration-cyan-400 underline-offset-2 hover:text-cyan-800 dark:text-cyan-300 dark:decoration-cyan-500 dark:hover:text-cyan-200"
              >
                IMSLP
              </Link>
              {" "}page. Only reference PDFs hosted on IMSLP are allowed, ensuring that the underlying compositions are public-domain or legally available in Canada where OurTextScores is hosted.
            </p>
            <p className="mt-4 text-slate-600 dark:text-slate-400">
              Public-domain status varies by country. If you are outside Canada, check the IMSLP page for your jurisdiction before downloading. Note also that an engraving may carry a separate copyright from the underlying composition.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-[linear-gradient(135deg,#ecfdf5_0%,#cffafe_40%,#dbeafe_100%)] p-8 shadow-sm dark:border-cyan-900/60 dark:bg-[linear-gradient(135deg,#0d9488,#0e7490,#0f172a,#134e4a,#0d9488)] dark:bg-[length:300%_300%] dark:[animation:hero-gradient-shift_12s_ease_infinite] dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <h2 className="font-[var(--font-heading)] text-3xl">Ways to Contribute</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {waysToContribute.map((entry) => (
              <article key={entry.title} className="rounded-lg border border-slate-200 bg-white p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-slate-600 dark:hover:shadow-lg dark:hover:shadow-slate-900/40">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100">{entry.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{entry.body}</p>
                {entry.title === "Report Bugs or Send PRs" && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      href="https://github.com/OurTextScores/OurTextScores/"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-cyan-300 bg-white/80 px-3 py-1.5 text-xs font-semibold text-cyan-800 transition-all duration-150 hover:-translate-y-px hover:bg-cyan-50 hover:shadow-sm dark:border-cyan-700 dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-slate-800"
                    >
                      OurTextScores Website Repo
                    </Link>
                    <Link
                      href="https://github.com/OurTextScores/OTS_WebEditor/"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-cyan-300 bg-white/80 px-3 py-1.5 text-xs font-semibold text-cyan-800 transition-all duration-150 hover:-translate-y-px hover:bg-cyan-50 hover:shadow-sm dark:border-cyan-700 dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-slate-800"
                    >
                      OTS_WebEditor Repo
                    </Link>
                  </div>
                )}
                {entry.title === "Join us on Discord" && (
                  <div className="mt-3">
                    <Link
                      href="https://discord.gg/wRzhrzJe"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition-all duration-150 hover:-translate-y-px hover:bg-indigo-100 hover:shadow-sm dark:border-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
                        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
                      </svg>
                      Join Discord Server
                    </Link>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
