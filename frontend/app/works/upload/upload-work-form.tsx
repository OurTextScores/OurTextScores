"use client";

import { FormEvent, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { EnsureWorkResponse } from "../../lib/api";
import { resolveImslpUrl } from "../../lib/api";

type Status =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "success"; payload: EnsureWorkResponse }
  | { state: "error"; message: string };

export default function UploadWorkForm() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [isPending, startTransition] = useTransition();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = url.trim();
    if (!trimmed) {
      setStatus({ state: "error", message: "Please enter an IMSLP work URL." });
      return;
    }

    setStatus({ state: "loading" });
    startTransition(async () => {
      try {
        const response = await resolveImslpUrl(trimmed);
        setStatus({ state: "success", payload: response });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({
          state: "error",
          message: message || "Unable to resolve the IMSLP work. Please try again."
        });
      }
    });
  };

  const resolvedWork = useMemo(() => {
    return status.state === "success" ? status.payload : null;
  }, [status]);

  const isLoading = status.state === "loading" || isPending;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-xl border border-slate-200 bg-white p-8 shadow-xl dark:border-slate-800 dark:bg-slate-900/70">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold text-slate-800 dark:text-slate-100">Save IMSLP work</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Paste any IMSLP work URL below. We will fetch its metadata and create a placeholder entry
          in the database you can upload sources to later.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 md:flex-row">
        <input
          type="url"
          inputMode="url"
          name="imslpUrl"
          placeholder="https://imslp.org/wiki/..."
          className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button
          type="submit"
          className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          disabled={isLoading}
        >
          {isLoading ? "Saving…" : "Save work"}
        </button>
      </form>

      {status.state === "error" && (
        <p className="rounded border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {status.message}
        </p>
      )}

      {resolvedWork && <ResolvedWorkAlert response={resolvedWork} onReset={() => setStatus({ state: "idle" })} />}
    </section>
  );
}

function ResolvedWorkAlert({
  response,
  onReset
}: {
  response: EnsureWorkResponse;
  onReset: () => void;
}) {
  const { work, metadata } = response;
  const permalink =
    metadata.permalink ||
    (metadata.workId ? `https://imslp.org/wiki/${metadata.workId}` : undefined);

  return (
    <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-500/40 dark:bg-emerald-500/10">
      <div className="space-y-1">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Success</p>
        <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
          Work {work.workId} is ready for uploads
        </h2>
        <p className="text-sm text-slate-700 dark:text-slate-200">
          The IMSLP metadata has been cached locally. You can now upload sources for this work.
        </p>
      </div>

      <dl className="grid gap-2 rounded-lg border border-emerald-200 bg-white p-4 text-sm text-slate-700 dark:border-emerald-400/20 dark:bg-slate-900/60 dark:text-slate-200 md:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Title</dt>
          <dd className="font-medium text-slate-800 dark:text-slate-100">{metadata.title || metadata.workId}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Composer</dt>
          <dd className="font-medium text-slate-800 dark:text-slate-100">{metadata.composer || "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">IMSLP permalink</dt>
          <dd>
            {permalink ? (
              <Link
                href={permalink}
                className="text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                target="_blank"
                rel="noreferrer"
              >
                {permalink}
              </Link>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Sources uploaded</dt>
          <dd>{work.sourceCount}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex gap-2">
          <Link
            href={`/works/${encodeURIComponent(work.workId)}`}
            className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            View work detail
          </Link>
          <Link
            href={`/upload?workId=${encodeURIComponent(work.workId)}`}
            className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Upload a source
          </Link>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="self-start text-xs font-medium uppercase tracking-wide text-slate-400 transition hover:text-slate-200 md:self-center"
        >
          Save another work
        </button>
      </div>
    </div>
  );
}
