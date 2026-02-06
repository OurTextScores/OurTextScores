/*
 * Copyright (C) 2025 OurTextScores Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

'use client';

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWorksPaginated, resolveImslpUrl, searchWorks, WorkSummary } from "../lib/api";
import SearchBox from "../components/SearchBox";
import Pagination from "../components/Pagination";

function formatDate(date?: string) {
  if (!date) return "—";
  return new Date(date).toLocaleString();
}

const ITEMS_PER_PAGE = 20;

export default function WorksPage() {
  const router = useRouter();
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterReferencePdf, setFilterReferencePdf] = useState<"any" | "yes" | "no">("any");
  const [filterVerified, setFilterVerified] = useState<"any" | "yes" | "no">("any");
  const [filterFlagged, setFilterFlagged] = useState<"any" | "yes" | "no">("any");
  const [imslpUrl, setImslpUrl] = useState("");
  const [imslpError, setImslpError] = useState<string | null>(null);
  const [isResolvingImslp, setIsResolvingImslp] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadWorks() {
      setIsLoading(true);
      try {
        const offset = (currentPage - 1) * ITEMS_PER_PAGE;
        const hasTriStateFilters = [
          filterReferencePdf,
          filterVerified,
          filterFlagged
        ].some((value) => value !== "any");
        const shouldUseFilter = hasTriStateFilters || !!searchQuery.trim();
        const filters: string[] = [];
        if (shouldUseFilter) {
          filters.push('sourceCount > 0');
          if (filterReferencePdf === "yes") filters.push('hasReferencePdf = true');
          if (filterReferencePdf === "no") filters.push('hasReferencePdf = false');
          if (filterVerified === "yes") filters.push('hasVerifiedSources = true');
          if (filterVerified === "no") filters.push('hasVerifiedSources = false');
          if (filterFlagged === "yes") filters.push('hasFlaggedSources = true');
          if (filterFlagged === "no") filters.push('hasFlaggedSources = false');
        }
        const filter = filters.length > 0 ? filters.join(' AND ') : undefined;

        if (searchQuery.trim()) {
          // Use search API when there's a query
          const result = await searchWorks(searchQuery, {
            limit: ITEMS_PER_PAGE,
            offset,
            filter,
          });
          setWorks(result.works);
          setTotalItems(result.total);
        } else {
          // Use regular fetch when no search query
          const result = await fetchWorksPaginated({
            limit: ITEMS_PER_PAGE,
            offset,
            filter: shouldUseFilter ? filter : undefined,
            onlyWithSources: !shouldUseFilter,
          });
          setWorks(result.works);
          setTotalItems(result.total);
        }
      } catch (error) {
        console.error("Failed to load works:", error);
        setWorks([]);
        setTotalItems(0);
      } finally {
        setIsLoading(false);
      }
    }

    loadWorks();
  }, [currentPage, searchQuery, filterReferencePdf, filterVerified, filterFlagged]);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setCurrentPage(1); // Reset to first page when searching
  }, []);

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    // Scroll to top when changing pages
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleImslpSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const url = imslpUrl.trim();
    if (!url) return;
    setImslpError(null);
    setIsResolvingImslp(true);
    try {
      const result = await resolveImslpUrl(url);
      router.push(`/works/${encodeURIComponent(result.work.workId)}`);
    } catch (error: any) {
      setImslpError(error?.message ?? "Unable to resolve IMSLP URL.");
    } finally {
      setIsResolvingImslp(false);
    }
  };

  const renderTriState = (
    label: string,
    value: "any" | "yes" | "no",
    onChange: (next: "any" | "yes" | "no") => void
  ) => (
    <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
      <span className="min-w-[140px]">{label}</span>
      <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        {[
          { value: "any" as const, label: "Any" },
          { value: "yes" as const, label: "On" },
          { value: "no" as const, label: "Off" }
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onChange(option.value);
              setCurrentPage(1);
            }}
            className={`px-3 py-1 text-xs font-semibold transition ${
              value === option.value
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-slate-50 py-12 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-4xl font-semibold tracking-tight">🎼 OurTextScores</h1>
            <p className="text-slate-600 dark:text-slate-300">
              Catalogue of editable community transcriptions of public domain works.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {[
              { href: '/works/upload', label: 'Save IMSLP work' },
              { href: '/upload', label: 'Upload source' }
            ].map((b) => (
              <Link
                key={b.href}
                href={b.href}
                className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {b.label}
              </Link>
            ))}
          </div>
        </header>

        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="w-full md:w-96">
            <SearchBox
              onSearch={handleSearch}
              placeholder="Search by title, composer, or catalogue..."
              debounceMs={300}
            />
          </div>
          <form onSubmit={handleImslpSubmit} className="w-full max-w-xl">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              IMSLP URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="url"
                value={imslpUrl}
                onChange={(event) => setImslpUrl(event.target.value)}
                placeholder="https://imslp.org/wiki/..."
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder-slate-600"
              />
              <button
                type="submit"
                disabled={!imslpUrl.trim() || isResolvingImslp}
                className="inline-flex items-center justify-center rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isResolvingImslp ? "Resolving..." : "Go"}
              </button>
            </div>
            {imslpError && (
              <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{imslpError}</p>
            )}
          </form>
        </div>

        {/* Filter Controls */}
        <div className="flex flex-col gap-3">
          {renderTriState("Has reference PDF", filterReferencePdf, setFilterReferencePdf)}
          {renderTriState("Admin verified", filterVerified, setFilterVerified)}
          {renderTriState("Has flagged sources", filterFlagged, setFilterFlagged)}
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="text-slate-500 dark:text-slate-400">
              <svg className="h-8 w-8 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </div>
          </div>
        )}

        {/* Works Table */}
        {!isLoading && (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
              <thead className="bg-slate-100 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Composer</th>
                  <th className="px-4 py-3">Catalogue</th>
                  <th className="px-4 py-3">Latest Revision</th>
                  <th className="px-4 py-3">Sources</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {works.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                      {searchQuery.trim()
                        ? `No works found matching "${searchQuery}"`
                        : "No works have been uploaded yet."}
                    </td>
                  </tr>
                )}
                {works.map((work) => (
                  <WorkRow key={work.workId} work={work} />
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            <Pagination
              currentPage={currentPage}
              totalItems={totalItems}
              itemsPerPage={ITEMS_PER_PAGE}
              onPageChange={handlePageChange}
            />
          </div>
        )}

        {/* Results Count (when not loading and has results) */}
        {!isLoading && totalItems > 0 && (
          <div className="text-center text-sm text-slate-500 dark:text-slate-400">
            {searchQuery.trim() && (
              <span>Found {totalItems} {totalItems === 1 ? 'work' : 'works'} matching &ldquo;{searchQuery}&rdquo;</span>
            )}
            {!searchQuery.trim() && (
              <span>Showing {totalItems} {totalItems === 1 ? 'work' : 'works'}</span>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function WorkRow({ work }: { work: WorkSummary }) {
  return (
    <tr className="transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <td className="px-4 py-4 font-medium text-slate-900 dark:text-slate-100">
        <Link href={`/works/${encodeURIComponent(work.workId)}`} className="hover:text-primary-600 hover:underline dark:hover:text-primary-400">
          {work.title ?? "—"}
        </Link>
      </td>
      <td className="px-4 py-4">{work.composer ?? "—"}</td>
      <td className="px-4 py-4">{work.catalogNumber ?? "—"}</td>
      <td className="px-4 py-4">{formatDate(work.latestRevisionAt)}</td>
      <td className="px-4 py-4">{work.sourceCount}</td>

    </tr>
  );
}
