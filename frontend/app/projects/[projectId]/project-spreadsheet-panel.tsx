import type { ProjectSummary } from "../../lib/api";

export default function ProjectSpreadsheetPanel({ project }: { project: ProjectSummary }) {
  const embedUrl = project.spreadsheetEmbedUrl?.trim();
  const externalUrl = project.spreadsheetExternalUrl?.trim();

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Spreadsheet</h2>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200"
          >
            Open Full Sheet
          </a>
        )}
      </div>
      {!embedUrl && (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          No embedded spreadsheet configured.
        </p>
      )}
      {embedUrl && (
        <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-700">
          <iframe
            src={embedUrl}
            className="h-[480px] w-full"
            title={`${project.title} spreadsheet`}
            loading="lazy"
          />
        </div>
      )}
    </section>
  );
}
