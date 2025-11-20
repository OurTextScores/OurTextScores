"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getPublicApiBase } from "../../lib/api";
import { useRouter } from "next/navigation";
import { StepState, initSteps, applyEventToSteps } from "../../components/progress-steps";
import { UploadProgressStepper, type UploadProgressStatus } from "../../components/upload-progress-stepper";

const API_BASE = getPublicApiBase();

const LICENSE_OPTIONS = [
  { value: '', label: '(No license specified)' },
  { value: 'CC0', label: 'CC0 - Public Domain Dedication' },
  { value: 'CC-BY-4.0', label: 'CC-BY 4.0 - Attribution' },
  { value: 'CC-BY-SA-4.0', label: 'CC-BY-SA 4.0 - Attribution-ShareAlike' },
  { value: 'CC-BY-NC-4.0', label: 'CC-BY-NC 4.0 - Attribution-NonCommercial' },
  { value: 'CC-BY-NC-SA-4.0', label: 'CC-BY-NC-SA 4.0 - Attribution-NonCommercial-ShareAlike' },
  { value: 'CC-BY-ND-4.0', label: 'CC-BY-ND 4.0 - Attribution-NoDerivatives' },
  { value: 'Public Domain', label: 'Public Domain' },
  { value: 'All Rights Reserved', label: 'All Rights Reserved (Copyright)' },
  { value: 'Other', label: 'Other (specify URL)' }
];

export default function UploadRevisionForm({
  workId,
  sourceId,
  defaultBranch,
  initialBranches
}: {
  workId: string;
  sourceId: string;
  defaultBranch?: string;
  initialBranches?: string[];
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [branchMode, setBranchMode] = useState<"existing" | "new">(
    () => (defaultBranch && defaultBranch !== "trunk") ? "existing" : "existing"
  );
  const [branchName, setBranchName] = useState(
    () => (defaultBranch && defaultBranch !== "trunk") ? defaultBranch : "trunk"
  );
  const [branches, setBranches] = useState<string[]>(() => initialBranches || []);
  const [busy, setBusy] = useState(false);
  const [license, setLicense] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [licenseAttribution, setLicenseAttribution] = useState("");
  const [status, setStatus] = useState<UploadProgressStatus>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ message: string; stage?: string; timestamp?: string }>>([]);
  const [steps, setSteps] = useState<StepState[]>(() => initSteps());
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const progressId = useMemo(
    () =>
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as any).randomUUID() as string
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    []
  );

  // Sync branches from server-provided list when it changes
  useEffect(() => {
    if (initialBranches && initialBranches.length) {
      setBranches(initialBranches);
    }
  }, [initialBranches]);

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setMsg("Choose a file first.");
      return;
    }
    setBusy(true);
    setStatus("running");
    setEvents([]);
    setSteps(initSteps());
    setStartedAt(Date.now());
    setMsg(null);
    try {
      // Open progress stream
      const streamUrl = `${API_BASE}/works/progress/${encodeURIComponent(progressId)}/stream`;
      const es = new EventSource(streamUrl);
      esRef.current = es;
      es.addEventListener('progress', (ev: MessageEvent) => {
        try {
          const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : (ev as any).data;
          const stage = (data?.stage as string | undefined) ?? undefined;
          setEvents((prev) => [...prev, { message: data?.message ?? String(data), stage, timestamp: data?.timestamp }]);
          setSteps((prev) => applyEventToSteps(prev, stage, startedAt ?? Date.now()));
        } catch {
          // ignore unparseable message
        }
      });
      es.addEventListener('done', () => {
        es.close();
        esRef.current = null;
      });

      const form = new FormData();
      form.append("file", file);
      if (commitMessage.trim()) form.append("commitMessage", commitMessage.trim());
      if (branchMode === 'existing' && branchName.trim()) {
        form.append("branchName", branchName.trim());
      }
      if (branchMode === 'new' && branchName.trim()) {
        form.append("createBranch", "true");
        form.append("branchName", branchName.trim());
      }
      if (license) form.append("license", license);
      if (licenseUrl.trim()) form.append("licenseUrl", licenseUrl.trim());
      if (licenseAttribution.trim()) form.append("licenseAttribution", licenseAttribution.trim());
      const res = await fetch(
        `/api/proxy/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions`,
        { method: "POST", body: form, headers: { 'X-Progress-Id': progressId } }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }
      setMsg("Revision uploaded.");
      setStatus("success");
      setFile(null);
      setCommitMessage("");
      setBranchMode('existing');
      setBranchName("trunk");
      setLicense("");
      setLicenseUrl("");
      setLicenseAttribution("");
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      setBusy(false);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    }
  };

  return (
    <form onSubmit={handleUpload} className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".mscz,.mxl,.xml"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-slate-700 file:mr-2 file:cursor-pointer file:rounded file:border-0 file:bg-cyan-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-cyan-700 dark:text-slate-300"
          data-testid="file-input"
        />
        <input
          type="text"
          placeholder="commit message (optional)"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
          <span>Commit to:</span>
          <label className="flex items-center gap-1">
            <input type="radio" name="branchMode" checked={branchMode==='existing'} onChange={() => { setBranchMode('existing'); }} /> existing
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="branchMode" checked={branchMode==='new'} onChange={() => setBranchMode('new')} /> new
          </label>
        </div>
        {branchMode==='existing' && (
          <select value={branchName} onChange={(e) => setBranchName(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
            <option value="">Select branch…</option>
            <option value="trunk">trunk</option>
            {branches.filter(b => b !== 'trunk').map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        )}
        {branchMode==='new' && (
          <input type="text" placeholder="branch name" value={branchName} onChange={(e) => setBranchName(e.target.value)} className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500" />
        )}
        <button
          type="submit"
          disabled={busy || !file}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          {busy ? "Uploading…" : "Upload new revision"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        >
          {LICENSE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {license === 'Other' && (
          <input
            type="url"
            placeholder="License URL (required for Other)"
            value={licenseUrl}
            onChange={(e) => setLicenseUrl(e.target.value)}
            className="flex-1 min-w-[16rem] rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        )}
        {(license.startsWith('CC-BY') || license === 'Public Domain') && license !== '' && (
          <input
            type="text"
            placeholder="Attribution (optional)"
            value={licenseAttribution}
            onChange={(e) => setLicenseAttribution(e.target.value)}
            className="flex-1 min-w-[14rem] rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        )}
      </div>
      {events.length > 0 && (
        <UploadProgressStepper
          steps={steps}
          events={events}
          status={status}
        />
      )}
      {msg && <div className="text-slate-400">{msg}</div>}
    </form>
  );
}
