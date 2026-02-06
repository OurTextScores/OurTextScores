"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProjectAction } from "./actions";

export default function CreateProjectForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [spreadsheetEmbedUrl, setSpreadsheetEmbedUrl] = useState("");
  const [spreadsheetExternalUrl, setSpreadsheetExternalUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createProjectAction({
        title: title.trim(),
        description: description.trim() || undefined,
        visibility,
        spreadsheetProvider: spreadsheetEmbedUrl.trim() || spreadsheetExternalUrl.trim() ? "google" : null,
        spreadsheetEmbedUrl: spreadsheetEmbedUrl.trim() || null,
        spreadsheetExternalUrl: spreadsheetExternalUrl.trim() || null
      });
      if (!result.ok) {
        if (result.requiresAuth) {
          router.push("/api/auth/signin");
          return;
        }
        setError(result.error || "Failed to create project");
        return;
      }
      router.push(`/projects/${encodeURIComponent(result.projectId)}`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Create Project</h2>
      {error && (
        <p className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-200">
          {error}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Project title"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          required
        />
        <div className="flex gap-2 md:col-span-2">
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "public" | "private")}
            className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
          <button
            type="submit"
            disabled={isPending || !title.trim()}
            className="rounded border border-cyan-300 bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200"
          >
            Create
          </button>
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          placeholder="Description"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 md:col-span-3"
        />
        <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 md:col-span-3">
          Spreadsheet Embed URL
          <input
            value={spreadsheetEmbedUrl}
            onChange={(e) => setSpreadsheetEmbedUrl(e.target.value)}
            placeholder="https://..."
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>
        <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 md:col-span-3">
          Spreadsheet External URL
          <input
            value={spreadsheetExternalUrl}
            onChange={(e) => setSpreadsheetExternalUrl(e.target.value)}
            placeholder="https://..."
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>
      </div>
    </form>
  );
}
