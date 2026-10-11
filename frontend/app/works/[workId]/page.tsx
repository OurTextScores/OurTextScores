import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
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
import PdfViewer from "./pdf-viewer";
import BranchesPanel from "./branches-panel";
import CopyDownload from "../../components/copy-download";
import WatchControls from "./watch-controls";
import { fetchBackendSession } from "../../lib/server-session";
import DeleteSourceButton from "./delete-source-button";
import LazyDetails from "../../components/lazy-details";
import StopPropagation from "../../components/stop-propagation";
import SourceCard from "./source-card";
import NotificationDeepLink from "./notification-deep-link";

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function renderJsonWithHighlight(jsonText: string) {
  const tokens: Array<{ text: string; className?: string }> = [];
  const regex = /("(?:\\.|[^"\\])*"(?=\\s*:)|"(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(jsonText)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: jsonText.slice(lastIndex, match.index) });
    }
    const [value] = match;
    const isKey = value.startsWith('"') && jsonText.slice(match.index + value.length).trimStart().startsWith(":");
    if (isKey) {
      tokens.push({ text: value, className: "text-sky-600 dark:text-sky-400" });
    } else if (value.startsWith('"')) {
      tokens.push({ text: value, className: "text-emerald-600 dark:text-emerald-400" });
    } else if (value === "true" || value === "false") {
      tokens.push({ text: value, className: "text-amber-600 dark:text-amber-400" });
    } else if (value === "null") {
      tokens.push({ text: value, className: "text-rose-600 dark:text-rose-400" });
    } else {
      tokens.push({ text: value, className: "text-purple-600 dark:text-purple-400" });
    }
    lastIndex = match.index + value.length;
  }

  if (lastIndex < jsonText.length) {
    tokens.push({ text: jsonText.slice(lastIndex) });
  }

  return tokens.map((token, index) =>
    token.className ? (
      <span key={index} className={token.className}>{token.text}</span>
    ) : (
      <span key={index}>{token.text}</span>
    )
  );
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
  const [work, imslp, raw, session] = await Promise.all([
    fetchWorkDetail(workId).catch(() => notFound()),
    fetchImslpMetadataByWorkId(workId).catch(() => undefined),
    fetchImslpRawDoc(workId),
    fetchBackendSession()
  ]);
  const currentUser = session.user;
  // Recommended source first: not flagged, verified, then most recently updated.
  const sources = [...work.sources].sort((x, y) => {
    const flag = Number(!!x.adminFlagged) - Number(!!y.adminFlagged);
    if (flag) return flag;
    const ver = Number(!!y.adminVerified) - Number(!!x.adminVerified);
    if (ver) return ver;
    return (Date.parse(y.latestRevisionAt ?? "") || 0) - (Date.parse(x.latestRevisionAt ?? "") || 0);
  });
  const imslpPermalink = imslp?.permalink || (imslp?.workId ? `https://imslp.org/wiki/${imslp.workId}` : undefined);

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-8 px-6">
        <header className="rounded-2xl bg-gradient-to-br from-white to-slate-100 p-6 shadow-sm ring-1 ring-slate-900/5 md:p-8 dark:from-midnight-900 dark:to-midnight-950 dark:ring-white/10">
          <Link href="/catalogue" className="text-sm text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
            ← Back to catalogue
          </Link>
          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
                {work.title ?? "Untitled Work"}
              </h1>
              <p className="text-lg text-slate-600 dark:text-slate-300">
                {work.composer ?? "Unknown Composer"}
                {(work as any).catalogNumber && (
                  <span className="ml-2 text-slate-400 dark:text-slate-500">• {(work as any).catalogNumber}</span>
                )}
              </p>
              <p className="pt-1 text-sm text-slate-500 dark:text-slate-400">
                {work.sourceCount} {work.sourceCount === 1 ? "source" : "sources"}
                {work.latestRevisionAt && <> · updated {formatDate(work.latestRevisionAt)}</>}
              </p>
            </div>
            {imslpPermalink && (
              <Link
                href={imslpPermalink}
                target="_blank"
                rel="noreferrer"
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                View on IMSLP ↗
              </Link>
            )}
          </div>
        </header>

        {currentUser && (
        <details className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <summary className="cursor-pointer p-5 text-lg font-semibold text-slate-800 dark:text-slate-100">
            Edit work details
          </summary>
          <div className="px-5 pb-5">
            <EditMetadataForm
              workId={workId}
              initial={{
                title: work.title ?? imslp?.title,
                composer: work.composer ?? imslp?.composer,
                catalogNumber: (work as any).catalogNumber
              }}
            />
          </div>
        </details>
        )}

        <section aria-labelledby="sources-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="sources-heading" className="font-heading text-2xl font-semibold">
              Sources
            </h2>
            {sources.length > 1 && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Start with the recommended source: verified first, then most recently updated.
              </p>
            )}
          </div>
          {sources.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-slate-600 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
              No sources have been uploaded for this work yet. Be the first: use “Add a source” below.
            </div>
          ) : (
            sources.map((source, index) => (
              <SourceCard
                key={source.sourceId}
                source={source}
                workId={workId}
                workTitle={work.title ?? imslp?.title}
                composer={work.composer ?? imslp?.composer}
                imslpPermalink={imslpPermalink}
                currentUser={currentUser}
                // The first source is the one to start with, so its card opens. It is only
                // called "recommended" when there is another to choose from.
                startOpen={index === 0}
                recommended={index === 0 && sources.length > 1}
                autoOpen={source.sourceId === targetSourceId}
                watchControlsSlot={
                  <Suspense fallback={<span className="rounded px-3 py-1 text-xs text-slate-400 ring-1 ring-slate-200 dark:ring-slate-700">Loading…</span>}>
                    <WatchControls workId={workId} sourceId={source.sourceId} />
                  </Suspense>
                }
                branchesPanelSlot={
                  <Suspense fallback={<div className="text-xs text-slate-500 dark:text-slate-400">Loading branches…</div>}>
                    <BranchesPanel
                      workId={workId}
                      sourceId={source.sourceId}
                      latestRevisionId={source.revisions[0]?.revisionId}
                      revisions={source.revisions}
                      currentUser={currentUser}
                    />
                  </Suspense>
                }
              />
            ))
          )}
        </section>

        {currentUser ? (
          <>
            <details
              open={sources.length === 0}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60"
            >
              <summary className="cursor-pointer text-lg font-semibold text-slate-800 dark:text-slate-100">
                Add a source
              </summary>
              <div className="mt-4">
                <UploadNewSourceForm workId={workId} imslpPermalink={imslpPermalink} />
              </div>
            </details>
          </>
        ) : (
          <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
            <Link href="/signin" className="font-semibold text-emerald-700 hover:underline dark:text-emerald-400">
              Sign in
            </Link>{" "}
            to add a source, upload revisions, or edit this work.
          </p>
        )}

        {imslp && (
          <details className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <summary className="cursor-pointer p-5 text-lg font-semibold text-slate-800 dark:text-slate-100">
              IMSLP details
              <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">work ID {work.workId}</span>
            </summary>
            <div className="px-5 pb-5">
              <ImslpMetadataCard
                imslp={imslp}
                raw={raw}
                workId={workId}
                overrides={{ title: work.title, composer: work.composer }}
              />
            </div>
          </details>
        )}

        {/* Deep link handler for notification links */}
        <NotificationDeepLink />
      </div>
    </main>
  );
}

export async function generateMetadata({
  params
}: {
  params: { workId: string };
}): Promise<Metadata> {
  const work = await fetchWorkDetail(params.workId).catch(() => undefined);
  if (!work) {
    return {
      title: "Work not found | OurTextScores"
    };
  }
  const title = work.title?.trim() || "Untitled Work";
  const composer = work.composer?.trim() || "Unknown Composer";
  const catalogNumber = (work as any).catalogNumber?.trim();
  const parts = [title, composer];
  if (catalogNumber) parts.push(catalogNumber);
  return {
    title: `${parts.join(" — ")} | OurTextScores`
  };
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
    <section>
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Metadata from IMSLP</h3>
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
          Show full record
        </summary>
        <div className="mt-2 rounded border border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-950">
          <div className="flex items-center justify-end">
            <CopyDownload text={JSON.stringify(raw ?? { metadata: meta }, null, 2)} filename={`imslp-${workId}.json`} />
          </div>
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded bg-slate-50 p-3 text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
            <code className="font-mono">
              {renderJsonWithHighlight(JSON.stringify(raw ?? { metadata: meta }, null, 2))}
            </code>
          </pre>
        </div>
      </details>
    </section>
  );
}
