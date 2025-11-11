"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
// no API base import; updates go through /api/proxy which attaches auth

export default function EditSourceForm({
  workId,
  sourceId,
  initial
}: {
  workId: string;
  sourceId: string;
  initial: { label?: string; description?: string };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [label, setLabel] = useState<string>(initial.label ?? "");
  const [description, setDescription] = useState<string>(initial.description ?? "");
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSaved(false);
    try {
      const res = await fetch(
        `/api/proxy/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            label: label.trim() || undefined,
            description: description.trim() || undefined
          })
        }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to update source');
      }
      setSaved(true);
      setIsEditing(false);
      startTransition(() => router.refresh());
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  };

  if (!isEditing) {
    return (
      <button
        onClick={() => setIsEditing(true)}
        className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
      >
        Edit title/description
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
      <div className="space-y-2">
        <div>
          <label htmlFor={`label-${sourceId}`} className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
            Source Title
          </label>
          <input
            id={`label-${sourceId}`}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g., Piano Score, Vocal Parts, etc."
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        </div>
        <div>
          <label htmlFor={`description-${sourceId}`} className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
            Description
          </label>
          <textarea
            id={`description-${sourceId}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Additional details about this source..."
            rows={2}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          {isPending ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setLabel(initial.label ?? "");
            setDescription(initial.description ?? "");
            setIsEditing(false);
            setError(undefined);
            setSaved(false);
          }}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          Cancel
        </button>
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>}
        {error && <span className="text-xs text-rose-600 dark:text-rose-400">{error}</span>}
      </div>
    </form>
  );
}
