"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EnsureWorkResponse, ImslpWorkSummary, WorkSummary } from "../lib/api";
import { ensureWork, resolveImslpUrl, searchImslp, getPublicApiBase } from "../lib/api";
import { StepState, initSteps, applyEventToSteps } from "../components/progress-steps";
import { UploadProgressStepper, type UploadProgressStatus } from "../components/upload-progress-stepper";

interface UploadFormProps {
  works: WorkSummary[];
}

type UploadStatus =
  | { state: "idle" }
  | { state: "submitting" }
  | { state: "success"; message: string; revisionId: string }
  | { state: "error"; message: string };


export default function UploadForm({ works }: UploadFormProps) {
  const router = useRouter();
  const [step, setStep] = useState<"select" | "upload">("select");
  const [selectedWork, setSelectedWork] = useState<EnsureWorkResponse | null>(null);
  const [status, setStatus] = useState<UploadStatus>({ state: "idle" });

  const handleWorkSelected = (work: EnsureWorkResponse) => {
    setSelectedWork(work);
    setStep("upload");
    setStatus({ state: "idle" });
  };

  const handleReset = () => {
    setSelectedWork(null);
    setStep("select");
    setStatus({ state: "idle" });
  };

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator active={step} />
      {step === "select" && (
        <WorkSelector existingWorks={works} onWorkSelected={handleWorkSelected} />
      )}
      {step === "upload" && selectedWork && (
        <UploadStep
          work={selectedWork}
          status={status}
          onStatusChange={setStatus}
          onReset={handleReset}
          router={router}
        />
      )}
    </div>
  );
}

function StepIndicator({ active }: { active: "select" | "upload" }) {
  return (
    <ol className="flex gap-4 text-sm font-medium">
      <li className={active === "select" ? "text-cyan-700 dark:text-cyan-300" : "text-slate-600 dark:text-slate-500"}>
        <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-current">
          1
        </span>
        Select work
      </li>
      <li className={active === "upload" ? "text-cyan-700 dark:text-cyan-300" : "text-slate-600 dark:text-slate-500"}>
        <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-current">
          2
        </span>
        Upload source
      </li>
    </ol>
  );
}

function WorkSelector({
  existingWorks,
  onWorkSelected
}: {
  existingWorks: WorkSummary[];
  onWorkSelected: (work: EnsureWorkResponse) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ImslpWorkSummary[]>([]);
  const [loading, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    setResults([]);
    setError(null);
  }, [query]);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      setResults([]);
      return;
    }

    startTransition(async () => {
      try {
        const data = await searchImslp(query, 12);
        setResults(data);
        setError(data.length === 0 ? "No IMSLP works found for that query." : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleExistingSelect = async (workId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        const ensured = await ensureWork(workId);
        onWorkSelected(ensured);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleUrlResolve = (event: React.FormEvent) => {
    event.preventDefault();
    if (!url.trim()) {
      setError("Please paste an IMSLP URL or slug.");
      return;
    }

    startTransition(async () => {
      try {
        const ensured = await resolveImslpUrl(url.trim());
        onWorkSelected(ensured);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const combinedWorks = useMemo(() => {
    const mappedExisting: ImslpWorkSummary[] = existingWorks.slice(0, 8).map((work) => ({
      workId: work.workId,
      title: work.workId,
      composer: undefined,
      permalink: `https://imslp.org/wiki/${work.workId}`,
      metadata: {}
    }));
    return results.length > 0 ? results : mappedExisting;
  }, [existingWorks, results]);

  return (
    <section className="grid gap-6 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/70">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Step 1 — Select IMSLP work</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Search by title or composer, or paste an IMSLP work URL. Once selected, metadata will be
          cached locally and the work will be ready for uploads.
        </p>
      </div>

      <form onSubmit={handleSearch} className="flex flex-col gap-2 md:flex-row">
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search IMSLP catalogue..."
          className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <button
          type="submit"
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      <form onSubmit={handleUrlResolve} className="flex flex-col gap-2 md:flex-row">
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://imslp.org/wiki/..."
          className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
        />
        <button
          type="submit"
          className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          Resolve URL
        </button>
      </form>

      {error && <p className="text-sm text-rose-300">{error}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {combinedWorks.map((work) => (
          <button
            key={`${work.workId}-${work.permalink}`}
            type="button"
            onClick={() => handleExistingSelect(work.workId)}
            className="flex flex-col gap-1 rounded border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-cyan-200 hover:bg-cyan-50 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-cyan-500/40 dark:hover:bg-slate-900"
          >
            <span className="font-semibold text-slate-800 dark:text-slate-100">{work.title || work.workId}</span>
            {work.composer && (
              <span className="text-xs text-slate-600 dark:text-slate-400">Composer: {work.composer}</span>
            )}
            <span className="text-xs text-cyan-700 dark:text-cyan-300">ID: {work.workId}</span>
          </button>
        ))}
        {combinedWorks.length === 0 && (
          <p className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-400">
            No suggestions available. Try searching above.
          </p>
        )}
      </div>
    </section>
  );
}

interface UploadStepProps {
  work: EnsureWorkResponse;
  status: UploadStatus;
  onStatusChange: (status: UploadStatus) => void;
  onReset: () => void;
  router: ReturnType<typeof useRouter>;
}

function UploadStep({ work, status, onStatusChange, onReset, router }: UploadStepProps) {
  const API_BASE = getPublicApiBase();
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [sources, setSources] = useState<{ sourceId: string; label: string }[]>([]);
  const [targetSourceId, setTargetSourceId] = useState<string>("new");
  const [createBranch, setCreateBranch] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>("main");
  const [events, setEvents] = useState<Array<{ message: string; stage?: string; timestamp?: string }>>([]);
  const [steps, setSteps] = useState<StepState[]>(() => initSteps());
  const esRef = useRef<EventSource | null>(null);
  const progressId = useMemo(() => {
    if (typeof window !== "undefined" && (window as any).crypto && typeof (window as any).crypto.randomUUID === 'function') {
      return (window as any).crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/works/${encodeURIComponent(work.work.workId)}`);
        if (res.ok) {
          const data = (await res.json()) as { sources: Array<{ sourceId: string; label: string }>; };
          setSources((data.sources || []).map((s) => ({ sourceId: s.sourceId, label: s.label })));
        }
      } catch {
        // ignore
      }
    };
    load();
  }, [work.work.workId]);

  // Load branches for existing sources
  useEffect(() => {
    async function loadBranches() {
      if (targetSourceId === 'new') {
        setBranches([]);
        setSelectedBranch('main');
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/works/${encodeURIComponent(work.work.workId)}/sources/${encodeURIComponent(targetSourceId)}/branches`);
        if (res.ok) {
          const j = await res.json();
          const names: string[] = Array.isArray(j?.branches) ? j.branches.map((b: any) => b.name) : [];
          setBranches(names.length > 0 ? names : ['main']);
          if (names.length > 0) setSelectedBranch(names[0]);
        }
      } catch {
        // ignore
      }
    }
    loadBranches();
  }, [targetSourceId, work.work.workId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!file) {
      onStatusChange({ state: "error", message: "Please choose a score file to upload." });
      return;
    }

    onStatusChange({ state: "submitting" });
    setEvents([]);
    const startedAt = Date.now();

    try {
      // Open SSE progress stream
      const streamUrl = `${API_BASE}/works/progress/${encodeURIComponent(progressId)}/stream`;
      const es = new EventSource(streamUrl);
      esRef.current = es;
      es.addEventListener('progress', (ev: MessageEvent) => {
        try {
          const data = typeof (ev as any).data === 'string' ? JSON.parse((ev as any).data) : (ev as any).data;
          setEvents((prev) => [...prev, { message: data?.message ?? String(data), stage: data?.stage, timestamp: data?.timestamp }]);
          setSteps((prev) => applyEventToSteps(prev, data?.stage, startedAt));
        } catch {
          setEvents((prev) => [...prev, { message: String((ev as any).data ?? 'progress') }]);
        }
      });
      es.addEventListener('done', () => {
        es.close();
        esRef.current = null;
      });

      const payload = new FormData();
      if (description.trim()) {
        payload.append("description", description.trim());
      }
      if (commitMessage.trim()) {
        payload.append("commitMessage", commitMessage.trim());
      }
      if (targetSourceId !== 'new') {
        if (createBranch && branchName.trim()) {
          payload.append('createBranch', 'true');
          payload.append('branchName', branchName.trim());
        } else if (selectedBranch) {
          payload.append('branchName', selectedBranch);
        }
      }
      payload.append("file", file);

      const url =
        targetSourceId === "new"
          ? `/api/proxy/works/${encodeURIComponent(work.work.workId)}/sources`
          : `/api/proxy/works/${encodeURIComponent(work.work.workId)}/sources/${encodeURIComponent(targetSourceId)}/revisions`;
      const response = await fetch(url, { method: "POST", body: payload, headers: { 'X-Progress-Id': progressId } });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Upload failed with status ${response.status}`);
      }

      const result = (await response.json()) as { revisionId: string; workId: string };
      onStatusChange({
        state: "success",
        message: `Uploaded revision ${result.revisionId}`,
        revisionId: result.revisionId
      });

      setDescription("");
      setFile(null);
      setCommitMessage("");
      router.refresh();
    } catch (error) {
      onStatusChange({
        state: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    }
  };

  return (
    <section className="grid gap-6 rounded-xl border border-slate-200 bg-white p-6 shadow dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Step 2 — Upload {targetSourceId === "new" ? "source" : "revision"} for {work.metadata.title || work.work.workId}
          </h2>
          {work.metadata.composer && (
            <p className="text-sm text-slate-600 dark:text-slate-300">Composer: {work.metadata.composer}</p>
          )}
          <p className="text-xs text-slate-400">
            IMSLP permalink:{" "}
            <a
              href={work.metadata.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
            >
              {work.metadata.permalink}
            </a>
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-700"
        >
          Choose different work
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" encType="multipart/form-data">
        <div>
          <label className="text-sm font-semibold text-slate-700 dark:text-slate-200" htmlFor="description">
            Description (optional)
          </label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>

        <div>
          <label className="text-sm font-semibold text-slate-700 dark:text-slate-200" htmlFor="commitMessage">
            Commit message (optional)
          </label>
          <input
            id="commitMessage"
            type="text"
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder="Describe your change"
          className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>

        {targetSourceId !== 'new' && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-700 dark:text-slate-300">Branch</label>
                <select
                  value={selectedBranch}
                  onChange={(e) => setSelectedBranch(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input type="checkbox" checked={createBranch} onChange={(e) => setCreateBranch(e.target.checked)} />
                <span>Create new branch</span>
              </label>
            </div>
            {createBranch && (
              <input
                type="text"
                placeholder="branch name"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
              />
            )}
          </div>
        )}

        <div>
          <label className="text-sm font-semibold text-slate-700 dark:text-slate-200" htmlFor="targetSource">
            Target
          </label>
          <select
            id="targetSource"
            value={targetSourceId}
            onChange={(e) => setTargetSourceId(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          >
            <option value="new">New source</option>
            {sources.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                Append to: {s.label} ({s.sourceId.slice(0, 8)})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-sm font-semibold text-slate-700 dark:text-slate-200" htmlFor="file">
            Score file (.mscz, .mxl, .xml)
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".mscz,.mxl,.xml"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm text-slate-700 file:mr-4 file:cursor-pointer file:rounded file:border-0 file:bg-cyan-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-cyan-700 dark:text-slate-300"
            required
          />
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <button
            type="submit"
            disabled={status.state === "submitting"}
          className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status.state === "submitting" ? "Uploading…" : "Upload source"}
          </button>

          {status.state === "error" && (
            <span className="text-sm text-rose-600 dark:text-rose-300">{status.message}</span>
          )}
          {status.state === "success" && (
            <span className="text-sm text-emerald-600 dark:text-emerald-300">
              {status.message} —{" "}
              <button
                type="button"
                className="text-emerald-700 underline underline-offset-2 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200"
                onClick={() =>
                  router.push(`/works/${encodeURIComponent(work.work.workId)}`)
                }
              >
                view work
              </button>
            </span>
          )}
        </div>

        {events.length > 0 && (
          <UploadProgressStepper
            steps={steps}
            events={events}
            status={mapUploadStatus(status.state)}
          />
        )}
      </form>
    </section>
  );
}

function mapUploadStatus(state: UploadStatus["state"]): UploadProgressStatus {
  if (state === "error") return "error";
  if (state === "success") return "success";
  if (state === "submitting") return "running";
  return "idle";
}
