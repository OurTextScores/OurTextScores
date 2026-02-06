"use client";

import { useState, useTransition } from "react";
import type { ProjectSummary } from "../../lib/api";
import { joinProjectAction, updateProjectAction } from "../actions";

function fmt(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function ProjectSummaryCard({
  project,
  canEdit,
  canJoin,
}: {
  project: ProjectSummary;
  canEdit: boolean;
  canJoin: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description || "");
  const [status, setStatus] = useState<ProjectSummary["status"]>(project.status);
  const [visibility, setVisibility] = useState<ProjectSummary["visibility"]>(project.visibility);
  const [spreadsheetEmbedUrl, setSpreadsheetEmbedUrl] = useState(project.spreadsheetEmbedUrl || "");
  const [spreadsheetExternalUrl, setSpreadsheetExternalUrl] = useState(project.spreadsheetExternalUrl || "");

  const onSave = () => {
    setError(null);
    startTransition(async () => {
      try {
        await updateProjectAction(project.projectId, {
          title: title.trim(),
          description: description.trim(),
          status,
          visibility,
          spreadsheetProvider: spreadsheetEmbedUrl.trim() || spreadsheetExternalUrl.trim() ? "google" : null,
          spreadsheetEmbedUrl: spreadsheetEmbedUrl.trim() || null,
          spreadsheetExternalUrl: spreadsheetExternalUrl.trim() || null,
        });
        setEditing(false);
      } catch (err: any) {
        setError(err?.message || "Failed to save project");
      }
    });
  };

  const onJoin = () => {
    setError(null);
    startTransition(async () => {
      try {
        await joinProjectAction(project.projectId);
      } catch (err: any) {
        setError(err?.message || "Failed to join project");
      }
    });
  };

  return (
    <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{project.title}</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{project.description || "No description"}</p>
        </div>
        <div className="flex items-center gap-2">
          {canJoin && (
            <button
              type="button"
              onClick={onJoin}
              disabled={isPending}
              className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200"
            >
              Join Project
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditing((prev) => !prev)}
              disabled={isPending}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {editing ? "Cancel" : "Edit"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
          Lead: {project.lead.username || project.lead.displayName || project.lead.userId}
        </span>
        <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
          Members: {project.members.length}
        </span>
        <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
          Status: {project.status}
        </span>
        <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
          Updated: {fmt(project.updatedAt)}
        </span>
      </div>

      {editing && canEdit && (
        <div className="mt-4 grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900">
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Description
            <textarea
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ProjectSummary["status"])}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="active">active</option>
                <option value="archived">archived</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Visibility
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as ProjectSummary["visibility"])}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="public">public</option>
                <option value="private">private</option>
              </select>
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-1">
            <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Spreadsheet Embed URL
              <input
                value={spreadsheetEmbedUrl}
                onChange={(e) => setSpreadsheetEmbedUrl(e.target.value)}
                placeholder="https://..."
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </label>
          </div>
          <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Spreadsheet External URL
            <input
              value={spreadsheetExternalUrl}
              onChange={(e) => setSpreadsheetExternalUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          {error && <p className="text-xs text-rose-600 dark:text-rose-300">{error}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSave}
              disabled={isPending}
              className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      )}

      {!editing && error && (
        <p className="mt-3 text-xs text-rose-600 dark:text-rose-300">{error}</p>
      )}
    </header>
  );
}
