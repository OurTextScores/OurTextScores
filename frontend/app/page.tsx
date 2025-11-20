import Link from "next/link";
import { fetchWorks, WorkSummary } from "./lib/api";

function formatDate(date?: string) {
  if (!date) return "—";
  return new Date(date).toLocaleString();
}

export default async function WorksPage() {
  const works = await fetchWorks();

  return (
    <main className="min-h-screen bg-slate-50 py-12 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-4xl font-semibold tracking-tight">🎼 OurTextScores</h1>
            <p className="text-slate-600 dark:text-slate-300">
              Browse machine-readable music scores sourced from IMSLP metadata, with full revision
              history and derivative artifacts.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {[
              { href: '/works/upload', label: 'Save IMSLP work' },
              { href: '/upload', label: 'Upload source' }
            ].map((b) => (
              <Link
                key={b.href}
                href={b.href}
                className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {b.label}
              </Link>
            ))}
          </div>
        </header>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3">Title</th>
                <th className="px-4 py-3">Composer</th>
                <th className="px-4 py-3">Catalogue</th>
                <th className="px-4 py-3">Latest Revision</th>
                <th className="px-4 py-3">Sources</th>
                <th className="px-4 py-3">Formats</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {works.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                    No works have been uploaded yet.
                  </td>
                </tr>
              )}
              {works.map((work) => (
                <WorkRow key={work.workId} work={work} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function WorkRow({ work }: { work: WorkSummary }) {
  return (
    <tr className="transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <td className="px-4 py-4 font-medium text-slate-900 dark:text-slate-100">
        <Link href={`/works/${encodeURIComponent(work.workId)}`} className="hover:text-primary-600 hover:underline dark:hover:text-primary-400">
          {work.title ?? "—"}
        </Link>
      </td>
      <td className="px-4 py-4">{work.composer ?? "—"}</td>
      <td className="px-4 py-4">{work.catalogNumber ?? "—"}</td>
      <td className="px-4 py-4">{formatDate(work.latestRevisionAt)}</td>
      <td className="px-4 py-4">{work.sourceCount}</td>
      <td className="px-4 py-4">
        <div className="flex flex-wrap gap-1">
          {work.availableFormats.length === 0 ? (
            <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">pending</span>
          ) : (
            work.availableFormats.map((format) => (
              <span
                key={format}
                className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
              >
                {format}
              </span>
            ))
          )}
        </div>
      </td>

    </tr>
  );
}
export const dynamic = "force-dynamic";
