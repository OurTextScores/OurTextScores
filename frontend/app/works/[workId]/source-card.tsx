"use client";

import { useState, Suspense, useTransition, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SourceView, SourceRevisionView, StorageLocator, BackendSessionUser } from "../../lib/api";
import { getPublicApiBase } from "../../lib/api";
import StopPropagation from "../../components/stop-propagation";
import EditSourceForm from "./edit-source-form";
import DeleteSourceButton from "./delete-source-button";
import RevisionHistory from "./revision-history";
import DiffPreview from "./diff-preview";
import LazyDetails from "../../components/lazy-details";
import UploadRevisionForm from "./upload-revision-form";
import { verifySourceAction, removeVerificationAction, flagSourceAction, removeFlagAction, migrateSourceAction } from "./admin-actions";

const PUBLIC_API_BASE = getPublicApiBase();

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

function AdminActionsPanel({
    workId,
    sourceId,
    source
}: {
    workId: string;
    sourceId: string;
    source: SourceView;
}) {
    const [verifyNote, setVerifyNote] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [migrateError, setMigrateError] = useState<string | null>(null);
    const [migrateUrl, setMigrateUrl] = useState("");
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleVerify = () => {
        setError(null);
        startTransition(async () => {
            try {
                await verifySourceAction(workId, sourceId, verifyNote.trim() || undefined);
            } catch (err: any) {
                setError(err.message || "Failed to verify source");
            }
        });
    };

    const handleRemoveVerification = () => {
        setError(null);
        startTransition(async () => {
            try {
                await removeVerificationAction(workId, sourceId);
            } catch (err: any) {
                setError(err.message || "Failed to remove verification");
            }
        });
    };

    const handleMigrate = () => {
        if (!migrateUrl.trim()) {
            setMigrateError("IMSLP URL is required");
            return;
        }
        setMigrateError(null);
        startTransition(async () => {
            try {
                const result = await migrateSourceAction(workId, sourceId, migrateUrl.trim());
                if (result?.newWorkId && result?.newSourceId) {
                    router.push(`/works/${encodeURIComponent(result.newWorkId)}?source=${encodeURIComponent(result.newSourceId)}`);
                } else if (result?.newWorkId) {
                    router.push(`/works/${encodeURIComponent(result.newWorkId)}`);
                }
            } catch (err: any) {
                setMigrateError(err.message || "Failed to migrate source");
            }
        });
    };

    return (
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 dark:border-slate-800 dark:bg-slate-900/30">
            <h3 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">Admin Actions</h3>
            {error && (
                <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
                    {error}
                </div>
            )}
            <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                    Source Verification
                </p>
                {source.adminVerified ? (
                    <div className="space-y-2">
                        <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200">
                            <p className="font-semibold">✅ Verified</p>
                            {source.adminVerificationNote && (
                                <p className="mt-1 text-xs">Note: {source.adminVerificationNote}</p>
                            )}
                            {source.adminVerifiedAt && (
                                <p className="mt-1 text-xs">
                                    {new Date(source.adminVerifiedAt).toLocaleString()}
                                </p>
                            )}
                        </div>
                        <button
                            onClick={handleRemoveVerification}
                            disabled={isPending}
                            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        >
                            Remove Verification
                        </button>
                    </div>
                ) : (
                    <div className="space-y-2">
                        <input
                            type="text"
                            placeholder="Optional note..."
                            value={verifyNote}
                            onChange={(e) => setVerifyNote(e.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
                        />
                        <button
                            onClick={handleVerify}
                            disabled={isPending}
                            className="w-full rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-200 dark:hover:bg-emerald-900"
                        >
                            Verify Source
                        </button>
                    </div>
                )}
            </div>
            <div className="mt-4 space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                    Migrate Source
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                    Move this source (and all revisions) to a different IMSLP work. This generates a new source ID.
                </p>
                {migrateError && (
                    <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
                        {migrateError}
                    </div>
                )}
                <input
                    type="text"
                    placeholder="https://imslp.org/wiki/Work_Title"
                    value={migrateUrl}
                    onChange={(e) => setMigrateUrl(e.target.value)}
                    className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
                />
                <button
                    onClick={handleMigrate}
                    disabled={isPending}
                    className="w-full rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
                >
                    Migrate Source
                </button>
            </div>
        </div>
    );
}

function ReferencePdfUploadPanel({
    workId,
    sourceId
}: {
    workId: string;
    sourceId: string;
}) {
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleUpload = () => {
        if (!file) {
            setError("Please select a PDF file.");
            return;
        }
        setError(null);
        startTransition(async () => {
            try {
                const tokenRes = await fetch("/api/auth/api-token", { cache: "no-store" });
                if (!tokenRes.ok) {
                    throw new Error("Sign in required");
                }
                const tokenBody = await tokenRes.json();
                const token = tokenBody?.token;
                if (!token) {
                    throw new Error("Sign in required");
                }

                const form = new FormData();
                form.append("referencePdf", file);
                const res = await fetch(
                    `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/reference.pdf`,
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${token}`
                        },
                        body: form,
                        cache: "no-store"
                    }
                );

                if (res.status === 401) {
                    throw new Error("Sign in required");
                }
                if (!res.ok) {
                    const text = await res.text();
                    let message = "Failed to upload reference PDF";
                    try {
                        const json = JSON.parse(text);
                        message = json.message || json.error || message;
                    } catch {
                        if (text && text.length < 200) message = text;
                    }
                    throw new Error(message);
                }

                setFile(null);
                router.refresh();
            } catch (err: any) {
                setError(err.message || "Failed to upload reference PDF");
            }
        });
    };

    return (
        <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 dark:border-slate-800 dark:bg-slate-900/30">
            <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Reference PDF</h3>
            <p className="mb-3 text-xs text-slate-600 dark:text-slate-400">
                Upload a reference PDF that matches the IMSLP hash. This can only be done once.
            </p>
            {error && (
                <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
                    {error}
                </div>
            )}
            <div className="flex flex-col gap-2">
                <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="text-sm text-slate-700 file:mr-3 file:rounded file:border-0 file:bg-slate-200 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-300 dark:text-slate-200 dark:file:bg-slate-700 dark:file:text-slate-100 dark:hover:file:bg-slate-600"
                />
                {file && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">{file.name}</span>
                )}
                <button
                    onClick={handleUpload}
                    disabled={isPending}
                    className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                    Upload Reference PDF
                </button>
            </div>
        </div>
    );
}

function FlagSourcePanel({
    workId,
    sourceId,
    source,
    isAdmin
}: {
    workId: string;
    sourceId: string;
    source: SourceView;
    isAdmin: boolean;
}) {
    const [flagReason, setFlagReason] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [isPending, startTransition] = useTransition();

    const handleFlag = () => {
        if (!flagReason.trim()) {
            setError("Flag reason is required");
            return;
        }
        setError(null);
        startTransition(async () => {
            try {
                await flagSourceAction(workId, sourceId, flagReason.trim());
            } catch (err: any) {
                setError(err.message || "Failed to flag source");
            }
        });
    };

    const handleRemoveFlag = () => {
        setError(null);
        startTransition(async () => {
            try {
                await removeFlagAction(workId, sourceId);
            } catch (err: any) {
                setError(err.message || "Failed to remove flag");
            }
        });
    };

    return (
        <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
            <h3 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">Report Issue</h3>
            {error && (
                <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
                    {error}
                </div>
            )}
            <div className="space-y-2">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                    Flag this source if it contains inappropriate content, is not a valid transcription, or violates terms of use.
                </p>
                {source.adminFlagged ? (
                    <div className="space-y-2">
                        <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200">
                            <p className="font-semibold">⚠️ Flagged for Review</p>
                            {source.adminFlagReason && (
                                <p className="mt-1 text-xs">Reason: {source.adminFlagReason}</p>
                            )}
                            {source.adminFlaggedAt && (
                                <p className="mt-1 text-xs">
                                    {new Date(source.adminFlaggedAt).toLocaleString()}
                                </p>
                            )}
                        </div>
                        {isAdmin && (
                            <button
                                onClick={handleRemoveFlag}
                                disabled={isPending}
                                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                            >
                                Remove Flag
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="space-y-2">
                        <input
                            type="text"
                            placeholder="Reason for flagging (required)..."
                            value={flagReason}
                            onChange={(e) => setFlagReason(e.target.value)}
                            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500"
                        />
                        <button
                            onClick={handleFlag}
                            disabled={isPending}
                            className="w-full rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/50 dark:text-rose-200 dark:hover:bg-rose-900"
                        >
                            Flag for Review
                        </button>
                    </div>
                )}
            </div>
        </div>
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
    kind: 'normalizedMxl' | 'canonicalXml' | 'pdf' | 'mscz' | 'referencePdf' | 'manifest';
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

    let href = '';
    const r = revisionId ? `?r=${encodeURIComponent(revisionId)}` : '';
    switch (kind) {
        case 'normalizedMxl':
            href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/normalized.mxl${r}`;
            break;
        case 'canonicalXml':
            href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/canonical.xml${r}`;
            break;
        case 'pdf':
            href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.pdf${r}`;
            break;
        case 'mscz':
            href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/score.mscz${r}`;
            break;
        case 'referencePdf':
            href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/reference.pdf`;
            break;
        case 'manifest':
            href = `${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/manifest.json${r}`;
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

export default function SourceCard({
    source,
    workId,
    imslpPermalink,
    currentUser,
    watchControlsSlot,
    branchesPanelSlot,
    autoOpen = false,
    autoOpenPanel = "revision-history"
}: {
    source: SourceView;
    workId: string;
    imslpPermalink?: string;
    currentUser: BackendSessionUser | null;
    watchControlsSlot: React.ReactNode;
    branchesPanelSlot: React.ReactNode;
    autoOpen?: boolean;
    autoOpenPanel?: "revision-history" | "source-pdf";
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [isRevisionHistoryOpen, setIsRevisionHistoryOpen] = useState(false);
    const [isSourcePdfOpen, setIsSourcePdfOpen] = useState(false);

    // Auto-open card and the requested panel when a source deep link is provided.
    useEffect(() => {
        if (autoOpen) {
            setIsOpen(true);
            if (autoOpenPanel === "source-pdf" && source.derivatives?.pdf) {
                setIsRevisionHistoryOpen(false);
                setIsSourcePdfOpen(true);
            } else {
                setIsRevisionHistoryOpen(true);
                setIsSourcePdfOpen(false);
            }
        }
    }, [autoOpen, autoOpenPanel, source.derivatives?.pdf]);
    const latest = source.revisions[0];
    const initialBranches = Array.from(new Set(["trunk", ...source.revisions.map((r: any) => r.fossilBranch).filter(Boolean)]));
    const isOwner =
        !!currentUser &&
        !!(source as any).provenance?.uploadedByUserId &&
        currentUser.userId === (source as any).provenance.uploadedByUserId;
    const isAdmin = Array.isArray(currentUser?.roles) && (currentUser.roles as string[]).includes("admin");

    const canUploadReferencePdf = (isAdmin || isOwner) && !source.hasReferencePdf;

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
        <article
            id={`source-${source.sourceId}`}
            className="rounded-xl bg-white shadow-sm ring-1 ring-slate-900/5 transition-all duration-300 hover:shadow-xl dark:bg-midnight-900/50 dark:shadow-none dark:ring-white/10"
        >
            <div
                className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800 md:flex-row md:items-center md:justify-between cursor-pointer"
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="flex items-start gap-4">
                    {source.derivatives?.thumbnail && (
                        <div className="group relative shrink-0">
                            <div className="h-20 w-14 overflow-hidden rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/thumbnail.png`}
                                    alt={`Thumbnail for ${source.label}`}
                                    className="h-full w-full object-cover"
                                />
                            </div>
                            <div className="pointer-events-none absolute left-full top-0 z-30 hidden translate-x-3 rounded-lg border border-slate-200 bg-white p-1 shadow-xl group-hover:block dark:border-slate-700 dark:bg-slate-900">
                                <img
                                    src={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/thumbnail.png`}
                                    alt={`Thumbnail for ${source.label}`}
                                    className="h-auto w-[300px] max-w-[300px] object-cover"
                                />
                            </div>
                        </div>
                    )}
                    <div>
                        <h2 className="text-xl font-semibold flex items-center gap-2">
                            <span className={`text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                            {source.label}
                        </h2>
                        {source.provenance?.uploadedByUsername && (
                            <StopPropagation className="pl-6">
                                <Link
                                    href={`/users/${encodeURIComponent(source.provenance.uploadedByUsername)}`}
                                    className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-300 transition hover:bg-indigo-200 dark:bg-indigo-500/20 dark:text-indigo-300 dark:ring-indigo-400/40 dark:hover:bg-indigo-500/30"
                                >
                                    {source.provenance.uploadedByUsername}
                                </Link>
                            </StopPropagation>
                        )}
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
                    {source.adminVerified && (
                        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:ring-emerald-400/40" title={source.adminVerificationNote || 'Verified by admin'}>
                            ✅ Admin Verified
                        </span>
                    )}
                    {source.adminFlagged && (
                        <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-400/40" title={source.adminFlagReason || 'Flagged for deletion by admin'}>
                            ⚠️ Flagged for Deletion
                        </span>
                    )}
                    {(source.projectBadges ?? []).slice(0, 2).map((project) => (
                        <Link
                            key={project.projectId}
                            href={`/projects/${encodeURIComponent(project.projectId)}`}
                            className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200 transition hover:bg-violet-100 dark:bg-violet-500/20 dark:text-violet-200 dark:ring-violet-400/40 dark:hover:bg-violet-500/30"
                        >
                            {project.title}
                        </Link>
                    ))}
                    {(source.projectBadges?.length ?? 0) > 2 && (
                        <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-violet-700 ring-1 ring-violet-200 dark:bg-violet-500/20 dark:text-violet-200 dark:ring-violet-400/40">
                            +{(source.projectBadges?.length ?? 0) - 2}
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
                    {source.hasReferencePdf && (
                        <Link
                            href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/reference.pdf`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        >
                            Download Reference PDF
                        </Link>
                    )}
                    {source.derivatives?.pdf && (
                        <Link
                            href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/score.pdf`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                        >
                            Download Source PDF
                        </Link>
                    )}
                    {source.derivatives?.normalizedMxl && (
                        <>
                            <Link
                                href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/normalized.mxl`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                            >
                                Download MXL
                            </Link>
                            <button
                                onClick={() => {
                                    const absoluteApiBase = PUBLIC_API_BASE.startsWith('http')
                                        ? PUBLIC_API_BASE
                                        : `${window.location.protocol}//${window.location.hostname}:4000${PUBLIC_API_BASE}`;
                                    const canonicalUrl = `${absoluteApiBase}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/canonical.xml`;
                                    const editorUrl = `/score-editor/index.html?score=${encodeURIComponent(canonicalUrl)}`;
                                    window.open(editorUrl, '_blank');
                                }}
                                className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-200 dark:hover:bg-cyan-900"
                            >
                                Open Score in Editor
                            </button>
                        </>
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
                                    label="MSCZ"
                                    kind="mscz"
                                    locator={latest.derivatives?.mscz}
                                    workId={workId}
                                    sourceId={source.sourceId}
                                    revisionId={latest.revisionId}
                                    validationStatus={latest.validation.status}
                                />
                                {source.hasReferencePdf && (
                                    <StorageBadge
                                        label="Reference PDF"
                                        kind="referencePdf"
                                        locator={
                                            latest.derivatives?.referencePdf ??
                                            source.derivatives?.referencePdf ??
                                            source.revisions.find((r) => r.derivatives?.referencePdf)?.derivatives?.referencePdf
                                        }
                                        workId={workId}
                                        sourceId={source.sourceId}
                                        revisionId={latest.revisionId}
                                        validationStatus={latest.validation.status}
                                    />
                                )}
                                <StorageBadge
                                    label="Manifest"
                                    kind="manifest"
                                    locator={latest.manifest}
                                    workId={workId}
                                    sourceId={source.sourceId}
                                    revisionId={latest.revisionId}
                                    validationStatus={latest.validation.status}
                                />
                            </div>
                        </div>
                    )}

                    <details
                        className="group"
                        open={isRevisionHistoryOpen}
                        onToggle={(event) => setIsRevisionHistoryOpen(event.currentTarget.open)}
                    >
                        <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">Revision history ({source.revisions.length})</summary>
                        <RevisionHistory
                            workId={workId}
                            sourceId={source.sourceId}
                            revisions={source.revisions as any}
                            branchNames={initialBranches}
                            publicApiBase={PUBLIC_API_BASE}
                            currentUser={currentUser ? { ...currentUser, isAdmin } : null}
                        />
                        <div className="px-5 pb-6">
                            <DiffPreview
                                workId={workId}
                                sourceId={source.sourceId}
                                revisions={source.revisions.map(r => ({ revisionId: r.revisionId, sequenceNumber: r.sequenceNumber, createdAt: r.createdAt as unknown as string, fossilBranch: (r as any).fossilBranch }))}
                            />
                        </div>
                    </details>

                    {source.hasReferencePdf && (
                        <LazyDetails
                            className="group border-t border-slate-200 dark:border-slate-800"
                            summary={
                                <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">
                                    Browse Reference
                                </summary>
                            }
                        >
                            <div className="px-5 pb-5">
                                <object
                                    data={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/reference.pdf`}
                                    type="application/pdf"
                                    className="h-[800px] w-full rounded border border-slate-200 dark:border-slate-700"
                                >
                                    <p className="p-4 text-sm text-slate-600 dark:text-slate-400">
                                        Your browser does not support PDF viewing.{' '}
                                        <a
                                            href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/reference.pdf`}
                                            className="text-primary-600 hover:underline dark:text-primary-400"
                                            download
                                        >
                                            Download Reference PDF
                                        </a>
                                    </p>
                                </object>
                            </div>
                        </LazyDetails>
                    )}

                    {source.derivatives?.pdf && (
                        <LazyDetails
                            className="group border-t border-slate-200 dark:border-slate-800"
                            open={isSourcePdfOpen}
                            onToggle={(event) => setIsSourcePdfOpen(event.currentTarget.open)}
                            summary={
                                <summary className="cursor-pointer px-5 py-3 text-sm text-slate-700 transition hover:bg-slate-100 group-open:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/40 dark:group-open:text-slate-100">
                                    Browse Source
                                </summary>
                            }
                        >
                            <div className="px-5 pb-5">
                                <object
                                    data={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/score.pdf${source.latestRevisionId ? `?r=${encodeURIComponent(source.latestRevisionId)}` : ''}`}
                                    type="application/pdf"
                                    className="h-[800px] w-full rounded border border-slate-200 dark:border-slate-700"
                                >
                                    <p className="p-4 text-sm text-slate-600 dark:text-slate-400">
                                        Your browser does not support PDF viewing.{' '}
                                        <a
                                            href={`${PUBLIC_API_BASE}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(source.sourceId)}/score.pdf${source.latestRevisionId ? `?r=${encodeURIComponent(source.latestRevisionId)}` : ''}`}
                                            className="text-primary-600 hover:underline dark:text-primary-400"
                                            download
                                        >
                                            Download Generated PDF
                                        </a>
                                    </p>
                                </object>
                            </div>
                        </LazyDetails>
                    )}

                    <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
                        <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Upload a new revision</h3>
                        <UploadRevisionForm
                            workId={workId}
                            sourceId={source.sourceId}
                            defaultBranch={(source.revisions[0]?.fossilBranch as any) ?? 'trunk'}
                            initialBranches={initialBranches}
                            imslpPermalink={imslpPermalink}
                        />
                    </div>
                    {canUploadReferencePdf && (
                        <ReferencePdfUploadPanel
                            workId={workId}
                            sourceId={source.sourceId}
                        />
                    )}
                    {isAdmin && (
                        <AdminActionsPanel
                            workId={workId}
                            sourceId={source.sourceId}
                            source={source}
                        />
                    )}
                    {currentUser && (
                        <FlagSourcePanel
                            workId={workId}
                            sourceId={source.sourceId}
                            source={source}
                            isAdmin={isAdmin}
                        />
                    )}
                    <div className="border-t border-slate-200 px-5 py-4 dark:border-slate-800">
                        {branchesPanelSlot}
                    </div>
                </div>
            )}
        </article>
    );
}
