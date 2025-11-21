"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { SourceView, SourceRevisionView, StorageLocator, BackendSessionUser } from "../../lib/api";
import { getPublicApiBase } from "../../lib/api";
import StopPropagation from "../../components/stop-propagation";
import EditSourceForm from "./edit-source-form";
import DeleteSourceButton from "./delete-source-button";
import RevisionHistory from "./revision-history";
import DiffPreview from "./diff-preview";
import LazyDetails from "../../components/lazy-details";
import MxlViewer from "./mxl-viewer";
import PdfViewer from "./pdf-viewer";
import UploadRevisionForm from "./upload-revision-form";

const MINIO_PUBLIC_BASE = process.env.NEXT_PUBLIC_MINIO_PUBLIC_URL;
const PUBLIC_API_BASE = getPublicApiBase();

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

export default function SourceCard({
    source,
    workId,
    currentUser,
    watchControlsSlot,
    branchesPanelSlot
}: {
    source: SourceView;
    workId: string;
    currentUser: BackendSessionUser | null;
    watchControlsSlot: React.ReactNode;
    branchesPanelSlot: React.ReactNode;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const latest = source.revisions[0];
    const initialBranches = Array.from(new Set(["trunk", ...source.revisions.map((r: any) => r.fossilBranch).filter(Boolean)]));
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
        <article className="rounded-xl bg-white shadow-sm ring-1 ring-slate-900/5 transition-all duration-300 hover:shadow-xl dark:bg-midnight-900/50 dark:shadow-none dark:ring-white/10">
            <div
                className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800 md:flex-row md:items-center md:justify-between cursor-pointer"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-start gap-4">
                    {source.derivatives?.thumbnail && buildObjectUrl(source.derivatives.thumbnail) && (
                        <div className="relative h-20 w-14 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={buildObjectUrl(source.derivatives.thumbnail)}
                                alt={`Thumbnail for ${source.label}`}
                                className="h-full w-full object-cover"
                            />
                        </div>
                    )}
                    <div>
                        <h2 className="text-xl font-semibold flex items-center gap-2">
                            <span className={`text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                            {source.label}{" "}
                            <span className="text-sm font-normal text-slate-600 dark:text-slate-400">
                                ({source.sourceType}, {source.format})
                            </span>
                        </h2>
                        {isOpen && (
                            <>
                                <p className="text-sm text-slate-600 dark:text-slate-400 pl-6">
                                    Original filename: {source.originalFilename || "—"}
                                </p>
                                {source.description && (
                                    <p className="text-sm text-slate-700 dark:text-slate-300 pl-6">{source.description}</p>
                                )}
                                <StopPropagation className="mt-2 pl-6">
                                    <EditSourceForm
                                        workId={workId}
                                        sourceId={source.sourceId}
                                        initial={{ label: source.label, description: source.description }}
                                    />
                                </StopPropagation>
                                {source.license && (
                                    <StopPropagation className="mt-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 pl-6">
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
                                    </StopPropagation>
                                )}
                            </>
                        )}
                    </div>
                </div>
                <StopPropagation className="flex flex-wrap items-center gap-2 pl-6 md:pl-0">
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
                    {watchControlsSlot}
                    {canDeleteSource && (
                        <DeleteSourceButton workId={workId} sourceId={source.sourceId} />
                    )}
                </StopPropagation>
            </div>

            {isOpen && (
                <div data-testid="source-card-body">
                    {latest && (
                        <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-300 md:flex-row md:items-start md:justify-between">
                            <div>
                                <p>
                                    Latest revision: <span className="font-mono text-cyan-700 dark:text-cyan-300">#{latest.sequenceNumber}</span>
                                </p>
                                <p className="text-slate-600 dark:text-slate-400">{formatDate(latest.createdAt as unknown as string)}</p>
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
                        <LazyDetails
                            className="group border-t border-slate-200 dark:border-slate-800"
                            summary={
                                <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">
                                    Score preview (MXL)
                                </summary>
                            }
                        >
                            <div className="px-5 pb-5">
                                <MxlViewer
                                    key={source.latestRevisionId || source.sourceId}
                                    workId={workId}
                                    sourceId={source.sourceId}
                                    revisionId={source.latestRevisionId}
                                />
                            </div>
                        </LazyDetails>
                    )}

                    {source.derivatives?.pdf && (
                        <LazyDetails
                            className="group border-t border-slate-200 dark:border-slate-800"
                            summary={
                                <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">
                                    Score preview (PDF)
                                </summary>
                            }
                        >
                            <div className="px-5 pb-5">
                                <PdfViewer
                                    key={(source.latestRevisionId || source.sourceId) + '-pdf'}
                                    workId={workId}
                                    sourceId={source.sourceId}
                                    revisionId={source.latestRevisionId}
                                />
                            </div>
                        </LazyDetails>
                    )}

                    <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
                        <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Upload a new revision</h3>
                        <UploadRevisionForm workId={workId} sourceId={source.sourceId} defaultBranch={(source.revisions[0]?.fossilBranch as any) ?? 'trunk'} initialBranches={initialBranches} />
                    </div>
                    <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
                        {branchesPanelSlot}
                    </div>
                </div>
            )}
        </article>
    );
}
