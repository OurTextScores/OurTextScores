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
import { useSession } from "next-auth/react";
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
  const { data: session } = useSession();
  const roles = Array.isArray((session?.user as { roles?: string[] } | undefined)?.roles)
    ? ((session?.user as { roles?: string[] }).roles as string[])
    : [];
  const isAdmin = roles.includes("admin");
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [totalSourceCount, setTotalSourceCount] = useState<number | undefined>(undefined);
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
        const effectiveHasTriStateFilters = isAdmin && hasTriStateFilters;
        const shouldUseFilter = effectiveHasTriStateFilters || !!searchQuery.trim();
        const filters: string[] = [];
        if (shouldUseFilter) {
          filters.push('sourceCount > 0');
          if (isAdmin) {
            if (filterReferencePdf === "yes") filters.push('hasReferencePdf = true');
            if (filterReferencePdf === "no") filters.push('hasReferencePdf = false');
            if (filterVerified === "yes") filters.push('hasVerifiedSources = true');
            if (filterVerified === "no") filters.push('hasVerifiedSources = false');
            if (filterFlagged === "yes") filters.push('hasFlaggedSources = true');
            if (filterFlagged === "no") filters.push('hasFlaggedSources = false');
          }
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
          setTotalSourceCount(undefined);
        } else {
          // Use regular fetch when no search query
          const result = await fetchWorksPaginated({
            limit: ITEMS_PER_PAGE,
            offset,
            filter: shouldUseFilter ? filter : undefined,
            onlyWithSources: !(!!searchQuery.trim() || effectiveHasTriStateFilters),
          });
          setWorks(result.works);
          setTotalItems(result.total);
          setTotalSourceCount(result.totalSourceCount);
        }
      } catch (error) {
        console.error("Failed to load works:", error);
        setWorks([]);
        setTotalItems(0);
        setTotalSourceCount(undefined);
      } finally {
        setIsLoading(false);
      }
    }

    loadWorks();
  }, [currentPage, filterFlagged, filterReferencePdf, filterVerified, isAdmin, searchQuery]);

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
    <div className="flex flex-col gap-2 text-sm text-slate-700 dark:text-slate-300 md:flex-row md:items-center md:justify-between">
      <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
      <div className="inline-flex overflow-hidden rounded-full border border-stone-200 bg-white/90 p-1 shadow-sm dark:border-slate-700 dark:bg-slate-900/80">
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
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
              value === option.value
                ? "bg-slate-900 text-white dark:bg-sky-300 dark:text-slate-950"
                : "bg-transparent text-slate-600 hover:bg-stone-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen py-10 text-slate-900 dark:text-slate-100">
      <section className="ots-shell flex flex-col gap-8 pb-12">
        <header className="ots-panel-strong grid gap-6 px-6 py-7 md:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] md:px-8">
          <div className="space-y-4">
            <div className="ots-kicker">Catalogue</div>
            <h1 className="font-[var(--font-heading)] text-4xl leading-tight md:text-5xl">
              Discover editable community scores.
            </h1>
            <p className="max-w-3xl text-sm leading-7 text-slate-700 dark:text-slate-300">
              Browse versioned transcriptions, follow source trails back to IMSLP, and jump directly into editorial workflows.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/works/upload" className="ots-button-primary">
                Save IMSLP work
              </Link>
              <Link href="/upload" className="ots-button-secondary">
                Upload source
              </Link>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-1">
            <div className="ots-stat">
              <div className="ots-kicker">Visible works</div>
              <div className="mt-2 text-3xl font-semibold">{isLoading ? "…" : totalItems}</div>
            </div>
            <div className="ots-stat">
              <div className="ots-kicker">Source count</div>
              <div className="mt-2 text-3xl font-semibold">
                {isLoading ? "…" : (totalSourceCount ?? "Live")}
              </div>
            </div>
            <div className="ots-stat">
              <div className="ots-kicker">Focus</div>
              <div className="mt-2 text-base font-semibold">Public-domain editorial workbench</div>
            </div>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="ots-panel p-5 md:p-6">
            <div className="ots-kicker">Search</div>
            <div className="mt-3">
              <SearchBox
                onSearch={handleSearch}
                placeholder="Search by title, composer, or catalogue..."
                debounceMs={300}
              />
            </div>
          </div>

          <form onSubmit={handleImslpSubmit} className="ots-panel p-5 md:p-6">
            <div className="ots-kicker">Jump from IMSLP</div>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Paste an IMSLP work URL to land on the matching catalogue entry.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <input
                type="url"
                value={imslpUrl}
                onChange={(event) => setImslpUrl(event.target.value)}
                placeholder="https://imslp.org/wiki/..."
                className="ots-input"
              />
              <button
                type="submit"
                disabled={!imslpUrl.trim() || isResolvingImslp}
                className="ots-button-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isResolvingImslp ? "Resolving..." : "Open linked work"}
              </button>
            </div>
            {imslpError && (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{imslpError}</p>
            )}
          </form>
        </div>

        {isAdmin && (
          <div className="ots-panel p-5 md:p-6">
            <div className="ots-kicker">Admin filters</div>
            <div className="mt-4 grid gap-4">
              {renderTriState("Has reference PDF", filterReferencePdf, setFilterReferencePdf)}
              {renderTriState("Admin verified", filterVerified, setFilterVerified)}
              {renderTriState("Has flagged sources", filterFlagged, setFilterFlagged)}
            </div>
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="ots-panel flex items-center justify-center py-12">
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
          <div className="ots-panel overflow-hidden">
            <div className="border-b border-stone-200/80 px-5 py-4 dark:border-slate-800">
              <div className="ots-kicker">Browse results</div>
            </div>
            <table className="min-w-full divide-y divide-stone-200/80 text-sm dark:divide-slate-800">
              <thead className="bg-stone-100/70 text-left text-xs uppercase tracking-[0.18em] text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
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
                    <td colSpan={5} className="px-4 py-10 text-center text-slate-400">
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
              <span>
                Showing {works.length > 0 ? (currentPage - 1) * ITEMS_PER_PAGE + 1 : 0} to{" "}
                {Math.min(currentPage * ITEMS_PER_PAGE, totalItems)} of {totalItems}{" "}
                {totalItems === 1 ? 'work' : 'works'}
                {totalSourceCount !== undefined
                  ? ` with ${totalSourceCount} ${totalSourceCount === 1 ? 'source' : 'sources'}`
                  : ""}
              </span>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function WorkRow({ work }: { work: WorkSummary }) {
  return (
    <tr className="transition hover:bg-stone-50/80 dark:hover:bg-slate-800/40">
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
