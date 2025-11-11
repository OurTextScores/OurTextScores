"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getPublicApiBase } from "../../lib/api";
import { useRouter } from "next/navigation";
import { StepState, StepStatus, initSteps, applyEventToSteps } from "../../components/progress-steps";

const API_BASE = getPublicApiBase();

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
  const [branchMode, setBranchMode] = useState<'trunk'|'existing'|'new'>(() => (defaultBranch && defaultBranch !== 'trunk') ? 'existing' : 'trunk');
  const [branchName, setBranchName] = useState(() => (defaultBranch && defaultBranch !== 'trunk') ? defaultBranch : "");
  const [branches, setBranches] = useState<string[]>(() => initialBranches || []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ message: string; stage?: string; timestamp?: string }>>([]);
  const [steps, setSteps] = useState<StepState[]>(() => initSteps());
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const progressId = useMemo(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? (crypto as any).randomUUID() as string : `${Date.now()}-${Math.random().toString(36).slice(2)}`), []);

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
      const res = await fetch(
        `/api/proxy/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/revisions`,
        { method: "POST", body: form, headers: { 'X-Progress-Id': progressId } }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }
      setMsg("Revision uploaded.");
      setFile(null);
      setCommitMessage("");
      setBranchMode('trunk');
      setBranchName("");
      router.refresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
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
            <input type="radio" name="branchMode" checked={branchMode==='trunk'} onChange={() => setBranchMode('trunk')} /> trunk
          </label>
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
      {busy && <ProgressStepper steps={steps} />}
      {msg && <div className="text-slate-400">{msg}</div>}
    </form>
  );
}

function ProgressStepper({ steps }: { steps: StepState[] }) {
  return (
    <div className="mt-2 rounded border border-slate-200 bg-white p-2 text-slate-700 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Processing</div>
      <ul className="space-y-1 text-xs">
        {steps
          .filter(s => !s.optional || s.status !== 'pending')
          .map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <StatusIcon status={s.status} />
              <span className="flex-1 truncate" title={s.label}>{s.label}</span>
              {typeof s.ms === 'number' && <span className="tabular-nums text-slate-500">{(s.ms/1000).toFixed(1)}s</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  const base = "h-3 w-3 inline-block";
  switch (status) {
    case 'done':
      return (
        <svg className={`${base} text-emerald-600`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.414l2.293 2.293 6.543-6.543a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      );
    case 'failed':
      return (
        <svg className={`${base} text-rose-600`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm-1-5a1 1 0 112 0 1 1 0 01-2 0zm0-6a1 1 0 012 0v4a1 1 0 11-2 0V7z" clipRule="evenodd" />
        </svg>
      );
    case 'skipped':
      return (
        <svg className={`${base} text-slate-400`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path d="M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'active':
      return (
        <span className={`relative ${base}`}>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-600" />
        </span>
      );
    default:
      return (
        <span className={`${base} rounded-full bg-slate-300 dark:bg-slate-600`} />
      );
  }
}
