import Link from "next/link";
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
import { getApiBase, getPublicApiBase } from "../../lib/api";
import { getApiAuthHeaders } from "../../lib/authToken";
import { fetchBackendSession, BackendSessionUser } from "../../lib/server-session";
import { prunePendingSourcesAction, deleteAllSourcesAction } from "./admin-actions";
import DeleteSourceButton from "./delete-source-button";
// (no client branch section components)

const MINIO_PUBLIC_BASE = process.env.NEXT_PUBLIC_MINIO_PUBLIC_URL;
const PUBLIC_API_BASE = getPublicApiBase();
const INTERNAL_API_BASE = getApiBase();

function buildObjectUrl(locator: StorageLocator): string | undefined {
  if (!MINIO_PUBLIC_BASE) return undefined;
  const normalizedBase = MINIO_PUBLIC_BASE.endsWith("/")
    ? MINIO_PUBLIC_BASE
    : `${MINIO_PUBLIC_BASE}/`;
  return `${normalizedBase}${locator.bucket}/${locator.objectKey}`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatBytes(bytes?: number) {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}

function statusColor(status: string) {
  switch (status) {
    case "passed":
      return "bg-emerald-100 text-emerald-700 ring-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/40";
    case "failed":
      return "bg-rose-100 text-rose-700 ring-rose-300 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-400/40";
    default:
      return "bg-amber-100 text-amber-700 ring-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:ring-amber-400/40";
  }
}

export default async function WorkDetailPage({
  params
}: {
  params: { workId: string };
}) {
  const { workId } = params;
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
        <header className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                <Link href="/" className="underline-offset-2 hover:underline">
                  ← Back to works
                </Link>
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                Work {work.workId}
              </h1>
              <div className="mt-2 grid gap-1 text-sm text-slate-300 md:grid-cols-3">
                <div>
                  <span className="text-slate-400">Title: </span>
                  <span className="text-slate-100">{work.title ?? "—"}</span>
                </div>
                <div>
                  <span className="text-slate-400">Composer: </span>
                  <span className="text-slate-100">{work.composer ?? "—"}</span>
                </div>
                <div>
                  <span className="text-slate-400">Catalog: </span>
                  <span className="text-slate-100">{(work as any).catalogNumber ?? "—"}</span>
                </div>
              </div>
            </div>
            <div className="text-right text-sm text-slate-400">
              <p>Sources: {work.sourceCount}</p>
              <p>Latest revision: {formatDate(work.latestRevisionAt)}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            {work.availableFormats.map((format) => (
              <span
                key={format}
                className="rounded-full bg-slate-100 px-3 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
              >
                {format}
              </span>
            ))}
            {work.availableFormats.length === 0 && (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                No derivatives yet
              </span>
            )}
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
              <SourceCard key={source.sourceId} source={source} workId={workId} currentUser={currentUser} />
            ))
          )}
        </section>
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

      {raw?._id && (
        <div className="mb-2 text-xs text-slate-600 dark:text-slate-400">Record ID: <span className="font-mono text-slate-700 dark:text-slate-300">{raw._id}</span></div>
      )}

      <dl className="grid gap-4 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Title</dt>
          <dd className="text-slate-800 dark:text-slate-100">{displayTitle}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Composer</dt>
          <dd className="text-slate-800 dark:text-slate-100">{displayComposer || "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Permalink</dt>
          <dd className="truncate text-cyan-700 dark:text-cyan-300">
            {permalink ? (
              <Link href={permalink} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                {permalink}
              </Link>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>

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

async function SourceCard({
  source,
  workId,
  currentUser
}: {
  source: SourceView;
  workId: string;
  currentUser: BackendSessionUser | null;
}) {
  const latest = source.revisions[0];
  // Fetch declared branches (includes ones without fossil commits yet)
  let declaredBranches: string[] = [];
  try {
    const headers = await getApiAuthHeaders();
    const res = await fetch(`${INTERNAL_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/branches`, { headers, cache: 'no-store' });
    const data = res.ok ? await res.json() : {};
    declaredBranches = Array.isArray(data?.branches) ? (data.branches as any[]).map((b) => b.name as string) : [];
  } catch {}
  const initialBranches = Array.from(new Set(["trunk", ...declaredBranches, ...source.revisions.map((r: any) => r.fossilBranch).filter(Boolean)]));
  const isOwner =
    !!currentUser &&
    !!(source as any).provenance?.uploadedByUserId &&
    currentUser.userId === (source as any).provenance.uploadedByUserId;
  const isAdmin = Array.isArray(currentUser?.roles) && (currentUser.roles as string[]).includes("admin");

  // Check if source has revisions from multiple users
  const distinctCreators = Array.from(
    new Set(
      source.revisions
        .map((r: any) => r.createdBy)
        .filter((id: any) => id && id !== 'system')
    )
  );
  const hasMultipleCreators = distinctCreators.length > 1;

  // Can only delete if:
  // 1. Admin (always allowed), OR
  // 2. Owner/sole creator AND no revisions from other users
  const canDeleteSource = isAdmin || (isOwner && !hasMultipleCreators);

  return (
    <article className="rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">
            {source.label}{" "}
            <span className="text-sm font-normal text-slate-600 dark:text-slate-400">
              ({source.sourceType}, {source.format})
            </span>
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Original filename: {source.originalFilename || "—"}
          </p>
          {source.description && (
            <p className="text-sm text-slate-700 dark:text-slate-300">{source.description}</p>
          )}
          <div className="mt-2">
            <EditSourceForm
              workId={workId}
              sourceId={source.sourceId}
              initial={{ label: source.label, description: source.description }}
            />
          </div>
          {source.license && (
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold">License:</span>
              {source.license === 'Other' && source.licenseUrl ? (
                <a
                  href={source.licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-600 underline-offset-2 hover:underline dark:text-cyan-400"
                >
                  {source.license} →
                </a>
              ) : source.license.startsWith('CC') ? (
                <a
                  href={`https://creativecommons.org/licenses/${source.license.toLowerCase().replace('cc-', '').replace('-4.0', '')}/4.0/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-600 underline-offset-2 hover:underline dark:text-cyan-400"
                >
                  {source.license} →
                </a>
              ) : (
                <span>{source.license}</span>
              )}
              {source.licenseAttribution && (
                <span className="text-slate-500 dark:text-slate-500">
                  · Attribution: {source.licenseAttribution}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ${statusColor(
              source.validation.status
            )}`}
          >
            {source.validation.status}
          </span>
          {source.isPrimary && (
            <span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-500/20 dark:text-cyan-300 dark:ring-cyan-400/40">
              Primary
            </span>
          )}
          {source.derivatives?.mscz && (
            <Link
              href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/score.mscz`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Download MSCZ
            </Link>
          )}
          {source.derivatives?.normalizedMxl && (
            <Link
              href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/normalized.mxl`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Download MXL
            </Link>
          )}
          {source.derivatives?.pdf && (
            <Link
              href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/score.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Download PDF
            </Link>
          )}
          {/* Watch toggle */}
          <WatchControls workId={workId} sourceId={source.sourceId} />
          {canDeleteSource && (
            <DeleteSourceButton workId={workId} sourceId={source.sourceId} />
          )}
        </div>
      </div>

      {latest && (
      <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-300 md:flex-row md:items-start md:justify-between">
          <div>
            <p>
              Latest revision: <span className="font-mono text-cyan-700 dark:text-cyan-300">{latest.revisionId}</span>
            </p>
            <p className="text-slate-600 dark:text-slate-400">Sequence #{latest.sequenceNumber} • {formatDate(latest.createdAt as unknown as string)}</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <StorageBadge
              label="Linearized"
              kind="linearizedXml"
              locator={latest.derivatives?.linearizedXml}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="Canonical XML"
              kind="canonicalXml"
              locator={latest.derivatives?.canonicalXml}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="MXL"
              kind="normalizedMxl"
              locator={latest.derivatives?.normalizedMxl}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="PDF"
              kind="pdf"
              locator={latest.derivatives?.pdf}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="Manifest"
              kind="manifest"
              locator={latest.manifest}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="Diff"
              kind="musicDiffReport"
              locator={latest.derivatives?.musicDiffReport}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              missingText={latest.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="Diff (visual)"
              kind="musicDiffHtml"
              locator={(latest.derivatives as any)?.musicDiffHtml}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              missingText={latest.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={latest.validation.status}
            />
            <StorageBadge
              label="Diff (visual PDF)"
              kind="musicDiffPdf"
              locator={(latest.derivatives as any)?.musicDiffPdf}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={latest.revisionId}
              missingText={latest.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={latest.validation.status}
            />
          </div>
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">Revision history ({source.revisions.length})</summary>
        <RevisionHistory workId={workId} sourceId={source.sourceId} revisions={source.revisions as any} branchNames={initialBranches} publicApiBase={PUBLIC_API_BASE} />
        <div className="px-5 pb-6">
          <DiffPreview
            workId={workId}
            sourceId={source.sourceId}
            revisions={source.revisions.map(r => ({ revisionId: r.revisionId, sequenceNumber: r.sequenceNumber, createdAt: r.createdAt as unknown as string, fossilBranch: (r as any).fossilBranch }))}
          />
        </div>
      </details>

      {source.derivatives?.normalizedMxl && (
        <details className="group border-t border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">Score preview (MXL)</summary>
          <div className="px-5 pb-5">
            <MxlViewer
              key={source.latestRevisionId || source.sourceId}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={source.latestRevisionId}
            />
          </div>
        </details>
      )}

      {source.derivatives?.pdf && (
        <details className="group border-t border-slate-200 dark:border-slate-800">
          <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">Score preview (PDF)</summary>
          <div className="px-5 pb-5">
            <PdfViewer
              key={(source.latestRevisionId || source.sourceId) + '-pdf'}
              workId={workId}
              sourceId={source.sourceId}
              revisionId={source.latestRevisionId}
            />
          </div>
        </details>
      )}

      <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
        <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Upload a new revision</h3>
        <UploadRevisionForm workId={workId} sourceId={source.sourceId} defaultBranch={(source.revisions[0]?.fossilBranch as any) ?? 'trunk'} initialBranches={initialBranches} />
      </div>
      <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
        <BranchesPanel workId={workId} sourceId={source.sourceId} latestRevisionId={latest?.revisionId} />
      </div>
    </article>
  );
}

function StorageBadge({
  label,
  kind,
  locator,
  workId,
  sourceId,
  revisionId,
  missingText,
  validationStatus
}: {
  label: string;
  kind: 'normalizedMxl' | 'canonicalXml' | 'linearizedXml' | 'pdf' | 'manifest' | 'musicDiffReport' | 'musicDiffHtml' | 'musicDiffPdf';
  locator?: StorageLocator;
  workId: string;
  sourceId: string;
  revisionId?: string;
  missingText?: string;
  validationStatus?: string;
}) {
  if (!locator) {
    let text = missingText;
    if (!text) {
      text = validationStatus === 'pending' ? 'pending' : 'unavailable';
    }
    return (
      <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
        {label}: {text}
      </span>
    );
  }

  const direct = buildObjectUrl(locator);
  let href = direct;
  if (!href) {
    const r = revisionId ? `?r=${encodeURIComponent(revisionId)}` : '';
    switch (kind) {
      case 'normalizedMxl':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/normalized.mxl${r}`;
        break;
      case 'canonicalXml':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml${r}`;
        break;
      case 'linearizedXml':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/linearized.lmx${r}`;
        break;
      case 'pdf':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.pdf${r}`;
        break;
      case 'manifest':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/manifest.json${r}`;
        break;
      case 'musicDiffReport':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff.txt${r}`;
        break;
      case 'musicDiffHtml':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff.html${r}`;
        break;
      case 'musicDiffPdf':
        href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff.pdf${r}`;
        break;
    }
  }
  const content = (
    <>
    <span className="font-semibold text-slate-700 dark:text-slate-200">{label}</span>
      <span className="text-slate-500 dark:text-slate-400">• {formatBytes(locator.sizeBytes)}</span>
    </>
  );

  return href ? (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded bg-cyan-50 px-3 py-1 text-xs text-cyan-700 ring-1 ring-cyan-200 transition hover:bg-cyan-100 dark:bg-cyan-500/20 dark:text-cyan-200 dark:ring-cyan-400/40 dark:hover:bg-cyan-500/30"
    >
      {content}
    </Link>
  ) : (
    <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">
      {content}
    </span>
  );
}

function RevisionRow({ revision, workId, sourceId }: { revision: SourceRevisionView; workId: string; sourceId: string }) {
  const artifactsAvailable = [
    revision.derivatives?.linearizedXml,
    revision.derivatives?.canonicalXml,
    revision.derivatives?.normalizedMxl,
    revision.derivatives?.pdf,
    revision.manifest,
    revision.derivatives?.musicDiffReport
  ].some(Boolean);

  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/20">
      <td className="px-3 py-2 font-mono text-slate-800 dark:text-slate-200">{revision.sequenceNumber}</td>
      <td className="px-3 py-2 font-mono text-xs text-cyan-700 dark:text-cyan-300">{revision.revisionId}</td>
      <td className="px-3 py-2">
        <div className="text-slate-800 dark:text-slate-200">{formatDate(revision.createdAt)}</div>
        <div className="text-slate-500 dark:text-slate-400">by {revision.createdBy}</div>
      </td>
      <td className="px-3 py-2 max-w-[18rem]">
        <div className="truncate text-slate-700 dark:text-slate-300" title={revision.changeSummary || ''}>
          {revision.changeSummary || '—'}
        </div>
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ring-1 ${statusColor(
            revision.validation.status
          )}`}
        >
          {revision.validation.status}
        </span>
      </td>
      <td className="px-3 py-2">
        {artifactsAvailable ? (
          <div className="flex flex-wrap gap-1">
            <StorageBadge
              label="LMX"
              kind="linearizedXml"
              locator={revision.derivatives?.linearizedXml}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="XML"
              kind="canonicalXml"
              locator={revision.derivatives?.canonicalXml}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="MXL"
              kind="normalizedMxl"
              locator={revision.derivatives?.normalizedMxl}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="PDF"
              kind="pdf"
              locator={revision.derivatives?.pdf}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="Manifest"
              kind="manifest"
              locator={revision.manifest}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="Diff"
              kind="musicDiffReport"
              locator={revision.derivatives?.musicDiffReport}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              missingText={revision.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="Diff (visual)"
              kind="musicDiffHtml"
              locator={(revision.derivatives as any)?.musicDiffHtml}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              missingText={revision.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="Diff (visual PDF)"
              kind="musicDiffPdf"
              locator={(revision.derivatives as any)?.musicDiffPdf}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              missingText={revision.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={revision.validation.status}
            />
          </div>
      ) : (
          <span className="text-slate-500">No artifacts yet</span>
        )}
      </td>
      <td className="px-3 py-2">
        {revision.fossilArtifactId ? (
          <div className="flex items-center gap-2">
            <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {revision.fossilArtifactId}
            </code>
            {revision.fossilBranch && (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
                {revision.fossilBranch}
              </span>
            )}
          </div>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
    </tr>
  );
}
