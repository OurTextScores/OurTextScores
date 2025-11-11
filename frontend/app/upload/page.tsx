import Link from "next/link";
import { fetchWorks } from "../lib/api";
import UploadForm from "./upload-form";

export default async function UploadPage() {
  const works = await fetchWorks();

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              <Link href="/" className="underline-offset-2 hover:underline">
                ← Back to works
              </Link>
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Upload a new source</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-300">
              Provide an IMSLP work identifier, describe the source, and attach a MusicXML (*.mxl or
              *.xml) or MuseScore (*.mscz) file. The pipeline will store the raw artifact, generate
              normalized derivatives, run diff tooling, and capture a Fossil revision automatically.
            </p>
          </div>
        </header>

        <section className="grid gap-10 md:grid-cols-[2fr,1fr]">
          <UploadForm works={works} />

          <aside className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Work reference</h2>
            <p className="mt-2 text-slate-600 dark:text-slate-400">
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
                    className="rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-cyan-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-cyan-200"
                  >
                    <div>{work.workId}</div>
                    <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
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
