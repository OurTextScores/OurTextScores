"use client";
import { useState, useTransition } from "react";
import { updateWorkMetadata, WorkSummary } from "../../lib/api";
import { useRouter } from "next/navigation";

export default function EditMetadataForm({
  workId,
  initial
}: {
  workId: string;
  initial: { title?: string; composer?: string; catalogNumber?: string };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState<string>(initial.title ?? "");
  const [composer, setComposer] = useState<string>(initial.composer ?? "");
  const [catalogNumber, setCatalogNumber] = useState<string>(initial.catalogNumber ?? "");
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<boolean>(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSaved(false);
    try {
      await updateWorkMetadata(workId, {
        title: title.trim() || undefined,
        composer: composer.trim() || undefined,
        catalogNumber: catalogNumber.trim() || undefined
      });
      setSaved(true);
      startTransition(() => router.refresh());
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
      <h2 className="mb-3 text-xl font-semibold text-slate-800 dark:text-slate-100">Work Info</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="title" className="mb-1 block text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Title</label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
              placeholder="Override title"
            />
          </div>
          <div>
            <label htmlFor="composer" className="mb-1 block text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Composer</label>
            <input
              id="composer"
              type="text"
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
              placeholder="Override composer"
            />
          </div>
          <div>
            <label htmlFor="catalogNumber" className="mb-1 block text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">Catalog number</label>
            <input
              id="catalogNumber"
              type="text"
              value={catalogNumber}
              onChange={(e) => setCatalogNumber(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
              placeholder="e.g., BWV 1007, Op. 35, K. 545"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {isPending ? "Saving..." : "Save"}
          </button>
          {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>}
          {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
        </div>
      </form>
    </section>
  );
}
