"use client";

import Link from "next/link";
import { Fragment, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  associatePdmxSourceAction,
  markPdmxGroupUnacceptableAction,
  updatePdmxImportAction,
  updatePdmxReviewAction
} from "./actions";

type PdmxListItem = {
  pdmxId: string;
  title?: string;
  songName?: string;
  artistName?: string;
  composerName?: string;
  license?: string;
  licenseConflict?: boolean;
  rating?: number;
  nViews?: number;
  nRatings?: number;
  nNotes?: number;
  hasPdf?: boolean;
  hasMxl?: boolean;
  subsets?: {
    allValid?: boolean;
    noLicenseConflict?: boolean;
  };
  review?: {
    qualityStatus?: "unknown" | "acceptable" | "unacceptable";
    excludedFromSearch?: boolean;
  };
  import?: {
    status?: "not_imported" | "importing" | "imported" | "failed";
    importedWorkId?: string;
    importedSourceId?: string;
    importedRevisionId?: string;
    importedProjectId?: string;
    imslpUrl?: string;
    error?: string;
  };
};

type PdmxGroupItem = {
  group: string;
  count: number;
  unacceptableCount?: number;
  excludedCount?: number;
  importedCount?: number;
  withPdfCount?: number;
  noLicenseConflictCount?: number;
};

type AssociateFormState = {
  imslpUrl: string;
  projectId: string;
  sourceLabel: string;
  license: string;
  adminVerified: boolean;
  referencePdfFile: File | null;
};

const LICENSE_OPTIONS = [
  "Public Domain",
  "CC0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC-BY-NC-SA-4.0",
  "CC-BY-ND-4.0",
  "All Rights Reserved",
  "Other"
] as const;

function safe(value?: string | number) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value);
}

function statusClass(status?: string) {
  if (status === "imported") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
  if (status === "importing") return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  if (status === "failed") return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
  return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
}

export default function PdmxClient({
  initialItems,
  initialGroups,
  initialGroupsTotal,
  groupLimit,
  groupOffset,
  projectOptions,
  defaultProjectId,
  total,
  limit,
  offset,
  initialQuery
}: {
  initialItems: PdmxListItem[];
  initialGroups: PdmxGroupItem[];
  initialGroupsTotal: number;
  groupLimit: number;
  groupOffset: number;
  projectOptions: Array<{ projectId: string; title?: string }>;
  defaultProjectId: string;
  total: number;
  limit: number;
  offset: number;
  initialQuery: {
    q: string;
    group: string;
    sort: string;
    includeUnacceptable: boolean;
    hideImported: boolean;
    requireNoLicenseConflict: boolean;
    subset: string;
    importStatus: string;
    hasPdf: string;
  };
}) {
  const router = useRouter();
  const [rows, setRows] = useState<PdmxListItem[]>(initialItems);
  const [groups, setGroups] = useState<PdmxGroupItem[]>(initialGroups);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [q, setQ] = useState(initialQuery.q);
  const [groupFilter, setGroupFilter] = useState(initialQuery.group);
  const [sort, setSort] = useState(initialQuery.sort);
  const [includeUnacceptable, setIncludeUnacceptable] = useState(initialQuery.includeUnacceptable);
  const [hideImported, setHideImported] = useState(initialQuery.hideImported);
  const [requireNoLicenseConflict, setRequireNoLicenseConflict] = useState(initialQuery.requireNoLicenseConflict);
  const [subset, setSubset] = useState(initialQuery.subset);
  const [importStatus, setImportStatus] = useState(initialQuery.importStatus);
  const [hasPdf, setHasPdf] = useState(initialQuery.hasPdf);
  const [associateById, setAssociateById] = useState<Record<string, AssociateFormState>>({});
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setRows(initialItems);
  }, [initialItems]);

  useEffect(() => {
    setGroups(initialGroups);
  }, [initialGroups]);

  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const hasGroupPrev = groupOffset > 0;
  const hasGroupNext = groupOffset + groupLimit < initialGroupsTotal;

  const buildParams = (nextOffset: number, nextGroupOffset: number, overrideGroup?: string) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    const groupValue = (overrideGroup ?? groupFilter).trim();
    if (groupValue) params.set("group", groupValue);
    if (sort) params.set("sort", sort);
    if (includeUnacceptable) params.set("includeUnacceptable", "true");
    if (hideImported) params.set("hideImported", "true");
    if (!requireNoLicenseConflict) params.set("requireNoLicenseConflict", "false");
    if (subset) params.set("subset", subset);
    if (importStatus) params.set("importStatus", importStatus);
    if (hasPdf) params.set("hasPdf", hasPdf);
    params.set("limit", String(limit));
    params.set("offset", String(Math.max(0, nextOffset)));
    params.set("groupLimit", String(groupLimit));
    params.set("groupOffset", String(Math.max(0, nextGroupOffset)));
    return params;
  };

  const navigateWith = (nextOffset: number, nextGroupOffset: number, overrideGroup?: string) => {
    const params = buildParams(nextOffset, nextGroupOffset, overrideGroup);
    router.push(`/pdmx?${params.toString()}`);
  };

  const applyFilters = () => {
    navigateWith(0, 0);
  };

  const applyGroupFromTable = (group: string) => {
    setGroupFilter(group);
    navigateWith(0, 0, group);
  };

  const clearGroupFilter = () => {
    setGroupFilter("");
    navigateWith(0, 0, "");
  };

  const patchRow = (pdmxId: string, patch: Partial<PdmxListItem>) => {
    setRows((prev) => prev.map((row) => (row.pdmxId === pdmxId ? { ...row, ...patch } : row)));
  };

  const defaultProjectFromOptions = projectOptions.find((project) => project.projectId === defaultProjectId)?.projectId
    || projectOptions[0]?.projectId
    || defaultProjectId;

  const defaultAssociateFormForRow = (row: PdmxListItem): AssociateFormState => {
    const rowLicense = String(row.license || "").trim();
    const license = (LICENSE_OPTIONS as readonly string[]).includes(rowLicense) ? rowLicense : "Public Domain";
    return {
      imslpUrl: row.import?.imslpUrl || "",
      projectId: row.import?.importedProjectId || defaultProjectFromOptions,
      sourceLabel: row.title || row.songName || "",
      license,
      adminVerified: false,
      referencePdfFile: null
    };
  };

  const upsertAssociateForm = (pdmxId: string, patch: Partial<AssociateFormState>, row: PdmxListItem) => {
    setAssociateById((prev) => {
      const current = prev[pdmxId] || defaultAssociateFormForRow(row);
      return {
        ...prev,
        [pdmxId]: { ...current, ...patch }
      };
    });
  };

  const markUnacceptable = (row: PdmxListItem) => {
    setError(null);
    setActiveRowId(row.pdmxId);
    startTransition(async () => {
      try {
        const updated = await updatePdmxReviewAction(row.pdmxId, {
          qualityStatus: "unacceptable",
          excludedFromSearch: true
        });
        patchRow(row.pdmxId, { review: updated.review });
      } catch (err: any) {
        setError(err?.message || "Failed to mark record unacceptable");
      } finally {
        setActiveRowId(null);
      }
    });
  };

  const toggleImported = (row: PdmxListItem) => {
    setError(null);
    setActiveRowId(row.pdmxId);
    startTransition(async () => {
      try {
        const nextStatus = row.import?.status === "imported" ? "not_imported" : "imported";
        const updated = await updatePdmxImportAction(row.pdmxId, {
          status: nextStatus
        });
        patchRow(row.pdmxId, { import: updated.import });
      } catch (err: any) {
        setError(err?.message || "Failed to update import status");
      } finally {
        setActiveRowId(null);
      }
    });
  };

  const markGroupUnacceptable = (group: PdmxGroupItem) => {
    setError(null);
    setActiveGroup(group.group);
    startTransition(async () => {
      try {
        await markPdmxGroupUnacceptableAction(group.group, {
          reason: `Marked unacceptable by group (${group.group})`
        });
        router.refresh();
      } catch (err: any) {
        setError(err?.message || "Failed to mark group unacceptable");
      } finally {
        setActiveGroup(null);
      }
    });
  };

  const submitAssociate = (row: PdmxListItem) => {
    const form = associateById[row.pdmxId] || defaultAssociateFormForRow(row);
    if (!form.imslpUrl.trim() || !form.projectId.trim()) {
      setError("IMSLP URL and projectId are required");
      return;
    }
    setError(null);
    setActiveRowId(row.pdmxId);
    startTransition(async () => {
      try {
        const payload = new FormData();
        payload.set("pdmxId", row.pdmxId);
        payload.set("imslpUrl", form.imslpUrl.trim());
        payload.set("projectId", form.projectId.trim());
        if (form.sourceLabel.trim()) payload.set("sourceLabel", form.sourceLabel.trim());
        if (form.license.trim()) payload.set("license", form.license.trim());
        if (form.adminVerified) payload.set("adminVerified", "true");
        if (form.referencePdfFile) payload.set("referencePdf", form.referencePdfFile);

        const result = await associatePdmxSourceAction(payload);
        patchRow(row.pdmxId, {
          import: {
            ...(row.import || {}),
            status: "imported",
            importedProjectId: form.projectId.trim(),
            imslpUrl: form.imslpUrl.trim(),
            importedWorkId: result.workId,
            importedSourceId: result.sourceId,
            importedRevisionId: result.revisionId,
            error: undefined
          }
        });
      } catch (err: any) {
        setError(err?.message || "Failed to associate/import source");
      } finally {
        setActiveRowId(null);
      }
    });
  };

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <h2 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">Search Filters</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title/composer/artist/PDMX id"
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <input
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            placeholder="Filter by group token"
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="updated_desc">Recently Updated</option>
            <option value="title_asc">Title (A-Z)</option>
            <option value="rating_desc">Rating (High-Low)</option>
            <option value="n_notes_desc">Note Count (High-Low)</option>
          </select>
          <select
            value={importStatus}
            onChange={(e) => setImportStatus(e.target.value)}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All Import Statuses</option>
            <option value="not_imported">Not Imported</option>
            <option value="importing">Importing</option>
            <option value="imported">Imported</option>
            <option value="failed">Failed</option>
          </select>
          <select
            value={hasPdf}
            onChange={(e) => setHasPdf(e.target.value)}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="true">Has PDF</option>
            <option value="">Any PDF state</option>
            <option value="false">Missing PDF</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={requireNoLicenseConflict}
              onChange={(e) => setRequireNoLicenseConflict(e.target.checked)}
            />
            Require no license conflict
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={includeUnacceptable}
              onChange={(e) => setIncludeUnacceptable(e.target.checked)}
            />
            Include unacceptable quality
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={hideImported}
              onChange={(e) => setHideImported(e.target.checked)}
            />
            Hide imported
          </label>
          <select
            value={subset}
            onChange={(e) => setSubset(e.target.value)}
            className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">No extra subset filter</option>
            <option value="all_valid">Subset: all_valid</option>
            <option value="rated">Subset: rated</option>
            <option value="deduplicated">Subset: deduplicated</option>
            <option value="rated_deduplicated">Subset: rated_deduplicated</option>
          </select>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={applyFilters}
            className="rounded border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
          >
            Apply Filters
          </button>
          {groupFilter.trim() && (
            <button
              type="button"
              onClick={clearGroupFilter}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Clear Group Filter
            </button>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-400">{total} records</span>
        </div>
      </div>

      {error && (
        <p className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
        <h2 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Largest Groups</h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Group frequencies for the current filters. Use this to identify candidates for separate project imports.
        </p>
        <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
          <table className="min-w-[760px] w-full divide-y divide-slate-200 text-xs dark:divide-slate-800">
            <thead className="bg-slate-100/80 text-left uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Group</th>
                <th className="px-3 py-2">Count</th>
                <th className="px-3 py-2">Imported</th>
                <th className="px-3 py-2">Unacceptable</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {groups.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-center text-slate-500 dark:text-slate-400">
                    No groups found for current filters.
                  </td>
                </tr>
              )}
              {groups.map((group) => (
                <tr
                  key={group.group}
                  className={groupFilter.trim().toLowerCase() === group.group.toLowerCase() ? "bg-cyan-50/60 dark:bg-cyan-900/20" : ""}
                >
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                    <button
                      type="button"
                      onClick={() => applyGroupFromTable(group.group)}
                      className="text-left underline-offset-2 hover:underline"
                    >
                      {group.group}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{safe(group.count)}</td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{safe(group.importedCount)}</td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{safe(group.unacceptableCount)}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      disabled={isPending && activeGroup === group.group}
                      onClick={() => markGroupUnacceptable(group)}
                      className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                    >
                      Mark group unacceptable
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
          <span>
            Showing {groups.length > 0 ? groupOffset + 1 : 0} to {Math.min(groupOffset + groups.length, initialGroupsTotal)} of {initialGroupsTotal} groups
          </span>
          <div className="flex gap-2">
            {hasGroupPrev ? (
              <button
                type="button"
                onClick={() => navigateWith(offset, Math.max(0, groupOffset - groupLimit))}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                Prev Groups
              </button>
            ) : (
              <span className="rounded border border-slate-200 px-2 py-1 text-slate-400 dark:border-slate-800">Prev Groups</span>
            )}
            {hasGroupNext ? (
              <button
                type="button"
                onClick={() => navigateWith(offset, groupOffset + groupLimit)}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                Next Groups
              </button>
            ) : (
              <span className="rounded border border-slate-200 px-2 py-1 text-slate-400 dark:border-slate-800">Next Groups</span>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/50">
        <table className="min-w-[1300px] w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
          <thead className="bg-slate-100/80 text-left text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">Record</th>
              <th className="px-3 py-2">Composer / Artist</th>
              <th className="px-3 py-2">License</th>
              <th className="px-3 py-2">Stats</th>
              <th className="px-3 py-2">Quality</th>
              <th className="px-3 py-2">Import</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500 dark:text-slate-400">
                  No PDMX records found for current filters.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const expanded = expandedId === row.pdmxId;
              const form = associateById[row.pdmxId] || defaultAssociateFormForRow(row);
              const projectSelectOptions = projectOptions.some((project) => project.projectId === form.projectId)
                ? projectOptions
                : [{ projectId: form.projectId, title: "Current project" }, ...projectOptions];
              return (
                <Fragment key={row.pdmxId}>
                  <tr className="hover:bg-slate-50 dark:hover:bg-slate-900/70">
                    <td className="px-3 py-3 align-top">
                      <p className="font-semibold text-slate-900 dark:text-slate-100">
                        {row.title || row.songName || row.pdmxId}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{row.pdmxId}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.subsets?.allValid && (
                          <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                            all_valid
                          </span>
                        )}
                        {row.subsets?.noLicenseConflict && (
                          <span className="rounded bg-cyan-100 px-2 py-0.5 text-[10px] font-semibold text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200">
                            no_license_conflict
                          </span>
                        )}
                        {row.hasPdf ? (
                          <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">
                            has_pdf
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                            no_pdf
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 align-top text-slate-700 dark:text-slate-300">
                      <p>{safe(row.composerName)}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">{safe(row.artistName)}</p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <p className="text-slate-700 dark:text-slate-300">{safe(row.license)}</p>
                      {row.licenseConflict && (
                        <span className="mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          license_conflict
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-slate-600 dark:text-slate-300">
                      <p>rating: {safe(row.rating)}</p>
                      <p>views: {safe(row.nViews)}</p>
                      <p>ratings: {safe(row.nRatings)}</p>
                      <p>notes: {safe(row.nNotes)}</p>
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {row.review?.qualityStatus || "unknown"}
                      </span>
                      {row.review?.excludedFromSearch && (
                        <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">excluded</p>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <span className={`rounded px-2 py-1 text-xs font-semibold ${statusClass(row.import?.status)}`}>
                        {row.import?.status || "not_imported"}
                      </span>
                      {row.import?.importedWorkId && row.import?.importedSourceId && (
                        <div className="mt-1">
                          <Link
                            href={`/works/${encodeURIComponent(row.import.importedWorkId)}?source=${encodeURIComponent(row.import.importedSourceId)}`}
                            className="text-xs text-cyan-700 hover:underline dark:text-cyan-300"
                          >
                            Open imported source
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : row.pdmxId)}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        >
                          {expanded ? "Collapse" : "Expand"}
                        </button>
                        <button
                          type="button"
                          disabled={isPending && activeRowId === row.pdmxId}
                          onClick={() => markUnacceptable(row)}
                          className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
                        >
                          Mark unacceptable
                        </button>
                        <button
                          type="button"
                          disabled={isPending && activeRowId === row.pdmxId}
                          onClick={() => toggleImported(row)}
                          className="rounded border border-cyan-300 bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
                        >
                          {row.import?.status === "imported" ? "Mark not imported" : "Mark imported"}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={7} className="bg-slate-50 px-3 py-4 dark:bg-slate-950/40">
                        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                          <div>
                            <h4 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">PDF Preview</h4>
                            {row.hasPdf ? (
                              <iframe
                                title={`PDMX PDF ${row.pdmxId}`}
                                src={`/api/proxy/pdmx/records/${encodeURIComponent(row.pdmxId)}/pdf`}
                                className="h-[580px] w-full rounded border border-slate-300 bg-white dark:border-slate-700"
                              />
                            ) : (
                              <div className="rounded border border-slate-300 bg-white p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                                No PDF available for this record.
                              </div>
                            )}
                          </div>
                          <div>
                            <h4 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                              Associate Source with IMSLP URL and project
                            </h4>
                            <div className="space-y-3 rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                              <div>
                                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                                  IMSLP URL
                                </label>
                                <input
                                  value={form.imslpUrl}
                                  onChange={(e) => upsertAssociateForm(row.pdmxId, { imslpUrl: e.target.value }, row)}
                                  placeholder="https://imslp.org/wiki/..."
                                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                                  Project ID
                                </label>
                                <select
                                  value={form.projectId}
                                  onChange={(e) => upsertAssociateForm(row.pdmxId, { projectId: e.target.value }, row)}
                                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                >
                                  {projectSelectOptions.map((project) => (
                                    <option key={project.projectId} value={project.projectId}>
                                      {project.projectId}{project.title ? ` - ${project.title}` : ""}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                                  Source Label (optional)
                                </label>
                                <input
                                  value={form.sourceLabel}
                                  onChange={(e) => upsertAssociateForm(row.pdmxId, { sourceLabel: e.target.value }, row)}
                                  placeholder="Optional label override"
                                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                                  License
                                </label>
                                <select
                                  value={form.license}
                                  onChange={(e) => upsertAssociateForm(row.pdmxId, { license: e.target.value }, row)}
                                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                >
                                  {LICENSE_OPTIONS.map((license) => (
                                    <option key={license} value={license}>{license}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                                  Reference PDF (optional)
                                </label>
                                <input
                                  type="file"
                                  accept=".pdf,application/pdf"
                                  onChange={(e) => upsertAssociateForm(row.pdmxId, { referencePdfFile: e.target.files?.[0] || null }, row)}
                                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:file:bg-slate-700 dark:file:text-slate-100"
                                />
                              </div>
                              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={form.adminVerified}
                                  onChange={(e) => upsertAssociateForm(row.pdmxId, { adminVerified: e.target.checked }, row)}
                                />
                                Mark source as admin verified
                              </label>
                              <button
                                type="button"
                                onClick={() => submitAssociate(row)}
                                disabled={isPending && activeRowId === row.pdmxId}
                                className="rounded border border-cyan-300 bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100 disabled:opacity-50 dark:border-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-200"
                              >
                                {(isPending && activeRowId === row.pdmxId) ? "Building source..." : "Build Source in Catalogue"}
                              </button>
                              {row.import?.error && (
                                <p className="text-xs text-rose-700 dark:text-rose-300">Last import error: {row.import.error}</p>
                              )}
                              {row.import?.importedProjectId && (
                                <p className="text-xs text-slate-500 dark:text-slate-400">
                                  Imported project: {row.import.importedProjectId}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>
          Showing {rows.length > 0 ? offset + 1 : 0} to {Math.min(offset + rows.length, total)} of {total}
        </span>
        <div className="flex gap-2">
          {hasPrev ? (
            <button
              type="button"
              onClick={() => navigateWith(Math.max(0, offset - limit), groupOffset)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Previous
            </button>
          ) : (
            <span className="rounded border border-slate-200 px-2 py-1 text-slate-400 dark:border-slate-800">Previous</span>
          )}
          {hasNext ? (
            <button
              type="button"
              onClick={() => navigateWith(offset + limit, groupOffset)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Next
            </button>
          ) : (
            <span className="rounded border border-slate-200 px-2 py-1 text-slate-400 dark:border-slate-800">Next</span>
          )}
        </div>
      </div>
    </section>
  );
}
