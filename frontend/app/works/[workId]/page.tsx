import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  fetchWorkDetail,
  fetchImslpMetadataByWorkId,
  fetchImslpRawDoc,
  SourceRevisionView,
  SourceView,
  StorageLocator,
  ImslpWorkSummary,
  ImslpRawDoc
} from "../../lib/api";
import RefreshImslpButton from "./refresh-button";
import EditMetadataForm from "./edit-metadata-form";
import EditSourceForm from "./edit-source-form";
import UploadRevisionForm from "./upload-revision-form";
import UploadNewSourceForm from "./upload-new-source-form";
import MxlViewer from "./mxl-viewer";
import PdfViewer from "./pdf-viewer";
import BranchesPanel from "./branches-panel";
import RevisionHistory from "./revision-history";
// Removed old open-diff panel in favor of visual inline diff preview
import DiffPreview from "./diff-preview";
import CopyDownload from "../../components/copy-download";
import WatchControls from "./watch-controls";
import { getPublicApiBase, BackendSessionUser } from "../../lib/api";
import { fetchBackendSession } from "../../lib/server-session";
import { prunePendingSourcesAction, deleteAllSourcesAction } from "./admin-actions";
import DeleteSourceButton from "./delete-source-button";
import LazyDetails from "../../components/lazy-details";
import StopPropagation from "../../components/stop-propagation";
import SourceCard from "./source-card";
import NotificationDeepLink from "./notification-deep-link";

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}



export default async function WorkDetailPage({
  params,
  searchParams
}: {
  params: { workId: string };
  searchParams: { source?: string; revision?: string; comment?: string };
}) {
  const { workId } = params;
  const targetSourceId = searchParams.source;
  const targetRevisionId = searchParams.revision;
  const targetCommentId = searchParams.comment;
  const [work, imslp, raw, session] = await Promise.all([
    fetchWorkDetail(workId).catch(() => notFound()),
    fetchImslpMetadataByWorkId(workId).catch(() => undefined),
    fetchImslpRawDoc(workId),
    fetchBackendSession()
  ]);
  const currentUser = session.user;
  const currentRoles = Array.isArray(currentUser?.roles) ? currentUser.roles as string[] : [];
  const isAdmin = currentRoles.includes("admin");

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-8 px-6">
        <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-white to-slate-100 p-8 shadow-sm ring-1 ring-slate-900/5 dark:from-midnight-900 dark:to-midnight-950 dark:ring-white/10">
          <div className="relative z-10 flex flex-col gap-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
                  <Link href="/" className="transition hover:text-slate-800 dark:hover:text-slate-200">
                    ← Back to works
                  </Link>
                  <span className="opacity-50">•</span>
                  <span className="font-mono opacity-75">ID: {work.workId}</span>
                </div>
                <h1 className="font-heading text-4xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-5xl">
                  {work.title ?? "Untitled Work"}
                </h1>
                <p className="text-xl text-slate-600 dark:text-slate-300">
                  {work.composer ?? "Unknown Composer"}
                  {(work as any).catalogNumber && (
                    <span className="ml-2 text-slate-400 dark:text-slate-500">• {(work as any).catalogNumber}</span>
                  )}
                </p>
              </div>
              <div className="text-right text-sm text-slate-500 dark:text-slate-400">
                <p>Sources: <span className="font-medium text-slate-900 dark:text-slate-200">{work.sourceCount}</span></p>
                <p>Latest revision: <span className="font-medium text-slate-900 dark:text-slate-200">{formatDate(work.latestRevisionAt)}</span></p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              {/* Badges removed as per request */}
            </div>
          </div>
        </header>

        {isAdmin && (
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-100">
            <h2 className="mb-1 text-base font-semibold">Admin tools</h2>
            <p className="mb-3 text-xs text-amber-800 dark:text-amber-200">
              These actions are destructive and cannot be undone. Are you sure before running them?
            </p>
            <div className="flex flex-wrap gap-3">
              <form
                action={async () => {
                  "use server";
                  await prunePendingSourcesAction(workId);
                }}
              >
                <button
                  type="submit"
                  className="rounded border border-amber-400 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 shadow-sm transition hover:bg-amber-200 dark:border-amber-500 dark:bg-amber-500/30 dark:text-amber-50 dark:hover:bg-amber-500/50"
                >
                  Prune pending sources
                </button>
              </form>
              <form
                action={async () => {
                  "use server";
                  await deleteAllSourcesAction(workId);
                }}
              >
                <button
                  type="submit"
                  className="rounded border border-rose-500 bg-rose-600 px-3 py-1 text-xs font-semibold text-white shadow-sm transition hover:bg-rose-700"
                >
                  Delete all sources for this work
                </button>
              </form>
            </div>
          </section>
        )}

        <EditMetadataForm
          workId={workId}
          initial={{
            title: work.title ?? imslp?.title,
            composer: work.composer ?? imslp?.composer,
            catalogNumber: (work as any).catalogNumber
          }}
        />

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="mb-3 text-lg font-semibold text-slate-800 dark:text-slate-100">Upload a new source</h2>
          <UploadNewSourceForm workId={workId} />
        </section>

        {imslp && (
          <ImslpMetadataCard
            imslp={imslp}
            raw={raw}
            workId={workId}
            overrides={{ title: work.title, composer: work.composer }}
          />
        )}

        <section className="flex flex-col gap-6">
          {work.sources.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-slate-300">
              No sources have been uploaded for this work.
            </div>
          ) : (
            work.sources.map((source) => (
              <SourceCard
                key={source.sourceId}
                source={source}
                workId={workId}
                currentUser={currentUser}
                autoOpen={source.sourceId === targetSourceId}
                watchControlsSlot={
                  <Suspense fallback={<span className="rounded px-3 py-1 text-xs text-slate-400 ring-1 ring-slate-200 dark:ring-slate-700">Loading…</span>}>
                    <WatchControls workId={workId} sourceId={source.sourceId} />
                  </Suspense>
                }
                branchesPanelSlot={
                  <Suspense fallback={<div className="text-xs text-slate-500 dark:text-slate-400">Loading branches…</div>}>
                    <BranchesPanel workId={workId} sourceId={source.sourceId} latestRevisionId={source.revisions[0]?.revisionId} />
                  </Suspense>
                }
              />
            ))
          )}
        </section>

        {/* Deep link handler for notification links */}
        <NotificationDeepLink />
      </div>
    </main>
  );
}

function ImslpMetadataCard({
  imslp,
  raw,
  workId,
  overrides
}: {
  imslp: ImslpWorkSummary;
  raw?: ImslpRawDoc;
  workId: string;
  overrides?: { title?: string; composer?: string };
}) {
  const permalink =
    imslp.permalink || (imslp.workId ? `https://imslp.org/wiki/${imslp.workId}` : undefined);
  const meta = (imslp.metadata || {}) as any;
  const refreshedAt = raw?.updatedAt || meta.timestamp;
  const displayTitle = (overrides?.title && overrides.title.trim()) || imslp.title || imslp.workId;
  const displayComposer = (overrides?.composer && overrides.composer.trim()) || imslp.composer;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">IMSLP Metadata</h2>
        <div className="flex items-center gap-3">
          {permalink && (
            <Link
              href={permalink}
              className="text-sm text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
              target="_blank"
              rel="noreferrer"
            >
              Open on IMSLP ↗
            </Link>
          )}
          <RefreshImslpButton workId={workId} />
        </div>
      </header>

      {refreshedAt && (
        <p className="-mt-2 mb-3 text-xs text-slate-600 dark:text-slate-400">
          Refreshed at: {new Date(refreshedAt).toLocaleString()}
        </p>
      )}

      {refreshedAt && (
        <p className="-mt-2 mb-3 text-xs text-slate-600 dark:text-slate-400">
          Refreshed at: {new Date(refreshedAt).toLocaleString()}
        </p>
      )}

      {/* Files */}
      {Array.isArray(meta.files) && meta.files.length > 0 && (
        <details className="group mt-4 rounded border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900/50">
          <summary className="cursor-pointer text-slate-700 transition hover:text-slate-900 dark:text-slate-200 dark:hover:text-slate-100">
            Files ({meta.files.length})
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs dark:divide-slate-800">
              <thead className="bg-slate-100 text-left uppercase tracking-wider text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {meta.files.map((f: any, idx: number) => (
                  <tr key={idx}>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-700 dark:text-slate-200">{f.name || f.title}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{f.file_type || f.extension || "—"}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{f.size ?? "—"}</td>
                    <td className="px-3 py-2">
                      {f.download_urls?.direct ? (
                        <Link
                          href={f.download_urls.direct}
                          target="_blank"
                          className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                        >
                          Download
                        </Link>
                      ) : f.url ? (
                        <Link href={f.url} target="_blank" className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300">
                          Link
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Raw full record JSON */}
      <details className="group mt-4">
        <summary className="cursor-pointer text-sm text-slate-700 transition hover:text-slate-900 group-open:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100 dark:group-open:text-slate-100">
          Show full record (JSON)
        </summary>
        <div className="mt-2 rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center justify-end">
            <CopyDownload text={JSON.stringify(raw ?? { metadata: meta }, null, 2)} filename={`imslp-${workId}.json`} />
          </div>
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded bg-slate-50 p-3 text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
            {JSON.stringify(raw ?? { metadata: meta }, null, 2)}
          </pre>
        </div>
      </details>
    </section>
  );
}
