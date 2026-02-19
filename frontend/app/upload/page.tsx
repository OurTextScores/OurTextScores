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
              *.xml) or MuseScore (*.mscz) file.
            </p>
          </div>
        </header>

        <section className="mx-auto max-w-3xl">
          <UploadForm works={works} />
        </section>
      </div>
    </main>
  );
}
