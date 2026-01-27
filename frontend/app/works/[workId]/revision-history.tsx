"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import RevisionRating from "./revision-rating";
import RevisionComments from "./revision-comments";

type StorageLocator = { bucket: string; objectKey: string; sizeBytes?: number };
type SourceRevisionView = {
  revisionId: string;
  sequenceNumber: number;
  createdAt?: string;
  createdBy?: string;
  createdByUsername?: string;
  changeSummary?: string;
  validation: { status: string };
  derivatives?: {
    linearizedXml?: StorageLocator;
    canonicalXml?: StorageLocator;
    normalizedMxl?: StorageLocator;
    pdf?: StorageLocator;
    mscz?: StorageLocator;
    musicDiffReport?: StorageLocator;
  };
  manifest?: StorageLocator;
  fossilArtifactId?: string;
  fossilBranch?: string;
  license?: string;
  licenseUrl?: string;
  licenseAttribution?: string;
};

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

export default function RevisionHistory({
  workId,
  sourceId,
  revisions,
  branchNames,
  publicApiBase,
  currentUser
}: {
  workId: string;
  sourceId: string;
  revisions: SourceRevisionView[];
  branchNames: string[];
  publicApiBase: string;
  currentUser?: { userId: string; email?: string; name?: string; isAdmin: boolean } | null;
}) {
  const uniqueBranches = useMemo(() => {
    const names = new Set<string>(["All", "trunk", ...branchNames]);
    for (const r of revisions) if (r.fossilBranch) names.add(r.fossilBranch);
    return Array.from(names);
  }, [revisions, branchNames]);
  const [selected, setSelected] = useState<string>("All");

  const filtered = selected === "All"
    ? revisions
    : revisions.filter((r) => r.fossilBranch === selected || (selected === 'trunk' && (!r.fossilBranch || r.fossilBranch === 'trunk')));

  return (
    <>
      <div className="flex items-center gap-2 px-5 py-2 text-xs text-slate-600 dark:text-slate-400">
        <label htmlFor="branch-filter" className="">Filter by branch:</label>
        <select id="branch-filter" value={selected} onChange={(e) => setSelected(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-950">
          {uniqueBranches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto px-4 pb-6">
        <table className="min-w-full divide-y divide-slate-200 text-xs dark:divide-slate-800">
          <thead className="bg-slate-100 text-left uppercase tracking-wider text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">Seq</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Message</th>
              <th className="px-3 py-2">License</th>
              <th className="px-3 py-2">Artifacts</th>
              <th className="px-3 py-2">Fossil</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-slate-700 dark:divide-slate-800 dark:text-slate-300">
            {filtered.map((revision) => (
              <RevisionRow key={revision.revisionId} revision={revision} workId={workId} sourceId={sourceId} publicApiBase={publicApiBase} currentUser={currentUser} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StorageBadge({
  label,
  kind,
  locator,
  workId,
  sourceId,
  revisionId,
  publicApiBase,
  missingText,
  validationStatus
}: {
  label: string;
  kind: 'normalizedMxl' | 'canonicalXml' | 'linearizedXml' | 'pdf' | 'mscz' | 'manifest' | 'musicDiffReport';
  locator?: StorageLocator;
  workId: string;
  sourceId: string;
  revisionId?: string;
  publicApiBase: string;
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
  let href: string | undefined;
  const r = revisionId ? `?r=${encodeURIComponent(revisionId)}` : '';
  switch (kind) {
    case 'normalizedMxl':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/normalized.mxl${r}`;
      break;
    case 'canonicalXml':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml${r}`;
      break;
    case 'linearizedXml':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/linearized.lmx${r}`;
      break;
    case 'pdf':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.pdf${r}`;
      break;
    case 'mscz':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.mscz${r}`;
      break;
    case 'manifest':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/manifest.json${r}`;
      break;
    case 'musicDiffReport':
      href = `${publicApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/musicdiff.txt${r}`;
      break;
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

function UserBadge({ userId, username }: { userId?: string; username?: string }) {
  if (!userId) return <span className="text-slate-500 dark:text-slate-400">unknown</span>;

  const displayName = username || userId;

  if (username) {
    return (
      <Link
        href={`/users/${encodeURIComponent(username)}`}
        className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-300 transition hover:bg-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-300 dark:ring-indigo-400/40 dark:hover:bg-indigo-500/30"
      >
        {displayName}
      </Link>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-300 dark:ring-indigo-400/40">
      {displayName}
    </span>
  );
}

function RevisionRow({ revision, workId, sourceId, publicApiBase, currentUser }: {
  revision: SourceRevisionView;
  workId: string;
  sourceId: string;
  publicApiBase: string;
  currentUser?: { userId: string; email?: string; name?: string; isAdmin: boolean } | null;
}) {
  const artifactsAvailable = [
    revision.derivatives?.linearizedXml,
    revision.derivatives?.canonicalXml,
    revision.derivatives?.normalizedMxl,
    revision.derivatives?.pdf,
    revision.manifest,
    revision.derivatives?.musicDiffReport
  ].some(Boolean);

  return (
    <>
      <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/20">
      <td className="px-3 py-2 font-mono text-slate-800 dark:text-slate-200">{revision.sequenceNumber}</td>
      <td className="px-3 py-2">
        <div className="text-slate-800 dark:text-slate-200">{formatDate(revision.createdAt)}</div>
        <div className="flex items-center gap-1.5">
          <span className="text-slate-500 dark:text-slate-400 text-xs">by</span>
          <UserBadge userId={revision.createdBy} username={revision.createdByUsername} />
        </div>
      </td>
      <td className="px-3 py-2 max-w-[18rem]">
        <div className="truncate text-slate-700 dark:text-slate-300" title={revision.changeSummary || ''}>
          {revision.changeSummary || '—'}
        </div>
      </td>
      <td className="px-3 py-2">
        {revision.license ? (
          <div className="flex flex-col">
            <span className="text-slate-700 dark:text-slate-300">{revision.license}</span>
            {revision.licenseUrl && (
              <a href={revision.licenseUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary-600 hover:underline dark:text-primary-400">
                View License
              </a>
            )}
          </div>
        ) : (
          <span className="text-slate-400">—</span>
        )}
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
              publicApiBase={publicApiBase}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="XML"
              kind="canonicalXml"
              locator={revision.derivatives?.canonicalXml}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              publicApiBase={publicApiBase}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="MXL"
              kind="normalizedMxl"
              locator={revision.derivatives?.normalizedMxl}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              publicApiBase={publicApiBase}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="PDF"
              kind="pdf"
              locator={revision.derivatives?.pdf}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              publicApiBase={publicApiBase}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="MSCZ"
              kind="mscz"
              locator={revision.derivatives?.mscz}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              publicApiBase={publicApiBase}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="Manifest"
              kind="manifest"
              locator={revision.manifest}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              publicApiBase={publicApiBase}
              validationStatus={revision.validation.status}
            />
            <StorageBadge
              label="Diff"
              kind="musicDiffReport"
              locator={revision.derivatives?.musicDiffReport}
              workId={workId}
              sourceId={sourceId}
              revisionId={revision.revisionId}
              publicApiBase={publicApiBase}
              missingText={revision.sequenceNumber === 1 ? 'n/a' : 'pending'}
              validationStatus={revision.validation.status}
            />
            {revision.derivatives?.canonicalXml && (
              <button
                onClick={() => {
                  const absoluteApiBase = publicApiBase.startsWith('http')
                    ? publicApiBase
                    : `${window.location.protocol}//${window.location.hostname}:4000${publicApiBase}`;
                  const canonicalUrl = `${absoluteApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml?r=${encodeURIComponent(revision.revisionId)}`;
                  const editorUrl = `/score-editor/index.html?score=${encodeURIComponent(canonicalUrl)}`;
                  window.open(editorUrl, '_blank');
                }}
                className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200 dark:hover:bg-cyan-900"
              >
                Open in Editor
              </button>
            )}
          </div>
        ) : (
          <span className="text-slate-500">No artifacts yet</span>
        )}
      </td>
      <td className="px-3 py-2">
        {revision.fossilBranch ? (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
            {revision.fossilBranch}
          </span>
        ) : (
          <span className="text-slate-500">—</span>
        )}
      </td>
      </tr>
      <tr>
        <td colSpan={6} className="p-0 bg-slate-50 dark:bg-slate-900/30">
          <RevisionRating
            workId={workId}
            sourceId={sourceId}
            revisionId={revision.revisionId}
            currentUser={currentUser}
          />
          <RevisionComments
            workId={workId}
            sourceId={sourceId}
            revisionId={revision.revisionId}
            currentUser={currentUser}
          />
        </td>
      </tr>
    </>
  );
}
