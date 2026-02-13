"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getPublicApiBase } from "../../lib/api";
import { getFileExtension, toAnalyticsError, trackUploadOutcomeClient } from "../../lib/analytics";
import { ClientMsczConversionProgress, prepareUploadScoreFile } from "../../lib/client-mscz-conversion";
import { StepState, initSteps, applyEventToSteps } from "../../components/progress-steps";
import { UploadProgressStepper, type UploadProgressStatus } from "../../components/upload-progress-stepper";
import { ClientConversionProgressCard } from "../../components/client-conversion-progress";

// Use public API base for browser uploads; auth is attached when available.
const API_BASE = getPublicApiBase();
const COPYRIGHT_LICENSE = "All Rights Reserved";
const COPYRIGHT_CERTIFICATION_TEXT = "I certify that I have permission from the copyright holder to upload this work.";

const LICENSE_OPTIONS = [
  { value: '', label: 'No license specified' },
  { value: 'CC0', label: 'CC0 - Public Domain Dedication' },
  { value: 'CC-BY-4.0', label: 'CC-BY 4.0 - Attribution' },
  { value: 'CC-BY-SA-4.0', label: 'CC-BY-SA 4.0 - Attribution-ShareAlike' },
  { value: 'CC-BY-NC-4.0', label: 'CC-BY-NC 4.0 - Attribution-NonCommercial' },
  { value: 'CC-BY-NC-SA-4.0', label: 'CC-BY-NC-SA 4.0 - Attribution-NonCommercial-ShareAlike' },
  { value: 'CC-BY-ND-4.0', label: 'CC-BY-ND 4.0 - Attribution-NoDerivatives' },
  { value: 'Public Domain', label: 'Public Domain' },
  { value: COPYRIGHT_LICENSE, label: 'All Rights Reserved (Copyright)' },
  { value: 'Other', label: 'Other (specify URL)' }
];

export default function UploadNewSourceForm({
  workId,
  imslpPermalink
}: {
  workId: string;
  imslpPermalink?: string;
}) {
  const refreshDelayMs = 5000;
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [referencePdfFile, setReferencePdfFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [licenseAttribution, setLicenseAttribution] = useState("");
  const [copyrightPermissionConfirmed, setCopyrightPermissionConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UploadProgressStatus>("idle");
  const [events, setEvents] = useState<Array<{ message: string; stage?: string; timestamp?: string }>>([]);
  const [steps, setSteps] = useState<StepState[]>(() => initSteps());
  const [clientConversionProgress, setClientConversionProgress] = useState<ClientMsczConversionProgress | null>(null);
  const [errorModal, setErrorModal] = useState<{ open: boolean; message: string } | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const progressId = useMemo(
    () =>
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as any).randomUUID() as string
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    []
  );
  const imslpUrl = imslpPermalink || (workId ? `https://imslp.org/wiki/${workId}` : undefined);
  const requiresCopyrightCertification = license === COPYRIGHT_LICENSE;
  const canSubmit = !busy && !!file && (!requiresCopyrightCertification || copyrightPermissionConfirmed);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setErrorModal({ open: true, message: "Choose a file first." });
      return;
    }
    if (requiresCopyrightCertification && !copyrightPermissionConfirmed) {
      setErrorModal({ open: true, message: COPYRIGHT_CERTIFICATION_TEXT });
      return;
    }
    setBusy(true);
    setStatus("running");
    setEvents([]);
    setSteps(initSteps());
    setClientConversionProgress(null);
    const startedAt = Date.now();
    const fileExt = getFileExtension(file.name);
    const hasReferencePdf = Boolean(referencePdfFile);
    try {
      const streamUrl = `${API_BASE}/works/progress/${encodeURIComponent(progressId)}/stream`;
      const es = new EventSource(streamUrl);
      esRef.current = es;
      es.addEventListener("progress", (ev: MessageEvent) => {
        try {
          const data = typeof ev.data === "string" ? JSON.parse(ev.data) : (ev as any).data;
          const stage = (data?.stage as string | undefined) ?? undefined;
          setEvents((prev) => [
            ...prev,
            { message: data?.message ?? String(data), stage, timestamp: data?.timestamp }
          ]);
          setSteps((prev) => applyEventToSteps(prev, stage, startedAt));
        } catch {
          setEvents((prev) => [
            ...prev,
            { message: String((ev as any).data ?? "progress") }
          ]);
        }
      });
      es.addEventListener("done", () => {
        es.close();
        esRef.current = null;
      });

      const form = new FormData();
      const preparedFile = await prepareUploadScoreFile(file, setClientConversionProgress);
      form.append("file", preparedFile.file);
      if (preparedFile.originalMsczFile) form.append("originalMscz", preparedFile.originalMsczFile);
      if (referencePdfFile) form.append("referencePdf", referencePdfFile);
      if (label.trim()) form.append("label", label.trim());
      if (commitMessage.trim()) form.append("commitMessage", commitMessage.trim());
      if (description.trim()) form.append("description", description.trim());
      if (license) form.append("license", license);
      if (licenseUrl.trim()) form.append("licenseUrl", licenseUrl.trim());
      if (licenseAttribution.trim()) form.append("licenseAttribution", licenseAttribution.trim());
      if (requiresCopyrightCertification) {
        form.append(
          "rightsDeclarationAccepted",
          copyrightPermissionConfirmed ? "true" : "false"
        );
      }

      let token: string | null = null;
      try {
        const tokenRes = await fetch("/api/auth/api-token", { cache: "no-store" });
        if (tokenRes.ok && typeof (tokenRes as any).json === "function") {
          const tokenBody = await tokenRes.json();
          if (typeof tokenBody?.token === "string" && tokenBody.token) {
            token = tokenBody.token;
          }
        }
      } catch {
        // Source uploads allow anonymous users; continue without auth.
      }

      const headers: Record<string, string> = { "X-Progress-Id": progressId };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const res = await fetch(`${API_BASE}/works/${encodeURIComponent(workId)}/sources`, {
        method: "POST",
        body: form,
        headers,
        cache: "no-store"
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }
      trackUploadOutcomeClient({
        flow: "work_page_new_source",
        outcome: "success",
        kind: "source",
        workId,
        fileExt,
        hasReferencePdf,
      });
      setStatus("success");
      setFile(null);
      setReferencePdfFile(null);
      setLabel("");
      setCommitMessage("");
      setDescription("");
      setLicense("");
      setLicenseUrl("");
      setLicenseAttribution("");
      setCopyrightPermissionConfirmed(false);
      setTimeout(() => {
        setStatus("idle");
        setEvents([]);
        setSteps(initSteps());
        setClientConversionProgress(null);
        router.refresh();
      }, refreshDelayMs);
    } catch (err) {
      trackUploadOutcomeClient({
        flow: "work_page_new_source",
        outcome: "failure",
        kind: "source",
        workId,
        fileExt,
        hasReferencePdf,
        error: toAnalyticsError(err),
      });
      setErrorModal({ open: true, message: err instanceof Error ? err.message : String(err) });
      setStatus("idle");
      setFile(null);
      setReferencePdfFile(null);
      setEvents([]);
      setSteps(initSteps());
    } finally {
      setBusy(false);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const refPdfInputRef = useRef<HTMLInputElement>(null);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".mscz,.mscx,.mxl,.xml"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
        >
          Upload Source
        </button>
        {file && <span className="text-slate-600 dark:text-slate-400">{file.name}</span>}

        <input
          ref={refPdfInputRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => setReferencePdfFile(e.target.files?.[0] ?? null)}
          className="hidden"
          title="Optional reference PDF"
        />
        <button
          type="button"
          onClick={() => refPdfInputRef.current?.click()}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
        >
          Upload IMSLP PDF Reference (optional)
        </button>
        {referencePdfFile && <span className="text-slate-600 dark:text-slate-400">{referencePdfFile.name}</span>}
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          title="Reference PDF must match an IMSLP PDF for this work."
        >
          IMSLP PDF rules
        </span>
        {imslpUrl && (
          <a
            href={imslpUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-400"
          >
            Open IMSLP ↗
          </a>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Source Title (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <input
          type="text"
          placeholder="Commit Message (optional)"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={license}
          onChange={(e) => {
            const next = e.target.value;
            setLicense(next);
            if (next !== COPYRIGHT_LICENSE) {
              setCopyrightPermissionConfirmed(false);
            }
          }}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          {LICENSE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {license === 'Other' && (
          <input
            type="url"
            placeholder="License URL (required for Other)"
            value={licenseUrl}
            onChange={(e) => setLicenseUrl(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        )}
        {(license.startsWith('CC-BY') || license === 'Public Domain') && license !== '' && (
          <input
            type="text"
            placeholder="Attribution (e.g., Your Name)"
            value={licenseAttribution}
            onChange={(e) => setLicenseAttribution(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        )}
        {requiresCopyrightCertification && (
          <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
            <input
              type="checkbox"
              checked={copyrightPermissionConfirmed}
              onChange={(e) => setCopyrightPermissionConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            <span>{COPYRIGHT_CERTIFICATION_TEXT}</span>
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload new source"}
        </button>
      </div>
      {events.length > 0 && (
        <UploadProgressStepper
          steps={steps}
          events={events}
          status={status}
        />
      )}
      <ClientConversionProgressCard progress={clientConversionProgress} />
      {errorModal?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="upload-error-title"
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
          >
            <h3 id="upload-error-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Upload failed
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">
              {errorModal.message}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  try {
                    void navigator.clipboard.writeText(errorModal.message);
                  } catch {}
                }}
                className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                Copy error
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setErrorModal(null)}
                className="rounded bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
