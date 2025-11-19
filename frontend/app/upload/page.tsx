import Link from "next/link";
import { fetchWorks } from "../lib/api";
import UploadForm from "./upload-form";

export default async function UploadPage() {
  const works = await fetchWorks();

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6">
        <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-white to-slate-100 p-8 shadow-sm ring-1 ring-slate-900/5 dark:from-midnight-900 dark:to-midnight-950 dark:ring-white/10">
          <div className="relative z-10 flex flex-col gap-4">
            <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
              <Link href="/" className="transition hover:text-slate-800 dark:hover:text-slate-200">
                ← Back to works
              </Link>
            </div>
            <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-4xl">
              Upload a new source
            </h1>
            <p className="max-w-2xl text-lg text-slate-600 dark:text-slate-300">
              Provide an IMSLP work identifier, describe the source, and attach a MusicXML (*.mxl or
              *.xml) or MuseScore (*.mscz) file. The pipeline will store the raw artifact, generate
              normalized derivatives, run diff tooling, and capture a Fossil revision automatically.
            </p>
          </div>
        </header>

        <section className="grid gap-10 md:grid-cols-[2fr,1fr]">
          <UploadForm works={works} />

          <aside className="h-fit rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-900/5 dark:bg-midnight-900/50 dark:shadow-none dark:ring-white/10">
            <h2 className="font-heading text-lg font-semibold text-slate-900 dark:text-white">Work reference</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Existing works (most recent first). Uploading to an unknown work id will create a stub
              record linked to the IMSLP metadata collection.
            </p>
            <div className="mt-4 flex max-h-80 flex-col gap-2 overflow-y-auto pr-2 text-xs">
              {works.length === 0 ? (
                <p className="text-slate-500">No works yet.</p>
              ) : (
                works.map((work) => (
                  <div
                    key={work.workId}
                    className="rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-primary-700 ring-1 ring-slate-900/5 dark:bg-white/5 dark:text-primary-300 dark:ring-white/10"
                  >
                    <div className="font-semibold">{work.workId}</div>
                    <div className="mt-1 flex items-center justify-between text-slate-500 dark:text-slate-400">
                      <span>Sources: {work.sourceCount}</span>
                      <span>{new Date(work.latestRevisionAt ?? 0).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
