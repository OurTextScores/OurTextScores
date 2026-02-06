"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getPublicApiBase } from "../../lib/api";
import { StepState, applyEventToSteps, initSteps } from "../../components/progress-steps";
import { UploadProgressStepper, type UploadProgressStatus } from "../../components/upload-progress-stepper";

const API_BASE = getPublicApiBase();

export default function ProjectUploadSourceForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UploadProgressStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ message: string; stage?: string; timestamp?: string }>>([]);
  const [steps, setSteps] = useState<StepState[]>(() => initSteps());
  const [imslpUrl, setImslpUrl] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [referencePdfFile, setReferencePdfFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const progressId = useMemo(
    () =>
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? ((crypto as any).randomUUID() as string)
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    []
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError("Choose a score file first.");
      return;
    }
    if (!imslpUrl.trim()) {
      setError("Provide IMSLP URL.");
      return;
    }

    setError(null);
    setBusy(true);
    setStatus("running");
    setEvents([]);
    setSteps(initSteps());
    const startedAt = Date.now();

    try {
      const streamUrl = `${API_BASE}/works/progress/${encodeURIComponent(progressId)}/stream`;
      const es = new EventSource(streamUrl);
      esRef.current = es;
      es.addEventListener("progress", (ev: MessageEvent) => {
        try {
          const data = typeof ev.data === "string" ? JSON.parse(ev.data) : (ev as any).data;
          const stage = (data?.stage as string | undefined) ?? undefined;
          setEvents((prev) => [...prev, { message: data?.message ?? String(data), stage, timestamp: data?.timestamp }]);
          setSteps((prev) => applyEventToSteps(prev, stage, startedAt));
        } catch {
          setEvents((prev) => [...prev, { message: String((ev as any).data ?? "progress") }]);
        }
      });
      es.addEventListener("done", () => {
        es.close();
        esRef.current = null;
      });

      const form = new FormData();
      form.append("file", file);
      if (referencePdfFile) form.append("referencePdf", referencePdfFile);
      if (imslpUrl.trim()) form.append("imslpUrl", imslpUrl.trim());
      if (label.trim()) form.append("label", label.trim());
      if (description.trim()) form.append("description", description.trim());
      if (commitMessage.trim()) form.append("commitMessage", commitMessage.trim());

      const res = await fetch(`/api/proxy/projects/${encodeURIComponent(projectId)}/sources`, {
        method: "POST",
        body: form,
        headers: { "X-Progress-Id": progressId },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Upload failed (${res.status})`);
      }

      setStatus("success");
      setFile(null);
      setReferencePdfFile(null);
      setLabel("");
      setDescription("");
      setCommitMessage("");
      router.refresh();
      setTimeout(() => {
        setStatus("idle");
        setEvents([]);
        setSteps(initSteps());
      }, 2000);
    } catch (err: any) {
      setStatus("idle");
      setEvents([]);
      setSteps(initSteps());
      setError(err?.message || "Upload failed");
    } finally {
      setBusy(false);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Upload Source</h2>
      <form onSubmit={onSubmit} className="grid gap-3">
        <div className="grid gap-3">
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            IMSLP URL
            <input
              value={imslpUrl}
              onChange={(e) => setImslpUrl(e.target.value)}
              placeholder="https://imslp.org/wiki/..."
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              required
            />
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Source Title (optional)
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 md:col-span-2">
            Description (optional)
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
        </div>

        <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          Commit Message (optional)
          <input
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

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
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            Choose Source File
          </button>
          {file && <span className="text-xs text-slate-600 dark:text-slate-400">{file.name}</span>}

          <input
            ref={referenceInputRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={(e) => setReferencePdfFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => referenceInputRef.current?.click()}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            Add Reference PDF
          </button>
          {referencePdfFile && <span className="text-xs text-slate-600 dark:text-slate-400">{referencePdfFile.name}</span>}
        </div>

        {error && <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p>}

        <div>
          <button
            type="submit"
            disabled={busy || !file}
            className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {busy ? "Uploading..." : "Create Internal Source + Upload"}
          </button>
        </div>
      </form>

      {events.length > 0 && <UploadProgressStepper steps={steps} events={events} status={status} />}
    </section>
  );
}
