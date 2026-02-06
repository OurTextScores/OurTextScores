"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Pagination from "../../components/Pagination";
import type { UserContribution } from "../../lib/api";

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function UserContributionsTable({
  contributions,
  total,
  currentPage,
  itemsPerPage,
}: {
  contributions: UserContribution[];
  total: number;
  currentPage: number;
  itemsPerPage: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handlePageChange = (page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (page <= 1) {
      params.delete("page");
    } else {
      params.set("page", String(page));
    }
    const next = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.push(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          Sources contributed to
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {total} total sources
        </p>
      </div>

      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <thead className="bg-slate-100 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-900/80 dark:text-slate-400">
          <tr>
            <th className="px-4 py-3">Title</th>
            <th className="px-4 py-3">Composer</th>
            <th className="px-4 py-3">Catalogue</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Last Contribution</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {contributions.length === 0 && (
            <tr>
              <td className="px-4 py-6 text-center text-slate-500 dark:text-slate-400" colSpan={5}>
                No contributions yet.
              </td>
            </tr>
          )}
          {contributions.map((item) => (
            <tr key={`${item.workId}-${item.sourceId}`} className="transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
              <td className="px-4 py-4 font-medium text-slate-900 dark:text-slate-100">
                <Link
                  href={`/works/${encodeURIComponent(item.workId)}?source=${encodeURIComponent(item.sourceId)}`}
                  className="text-cyan-700 hover:underline dark:text-cyan-300"
                >
                  {item.workTitle ?? item.workId}
                </Link>
              </td>
              <td className="px-4 py-4">{item.workComposer ?? "—"}</td>
              <td className="px-4 py-4">{item.workCatalogNumber ?? "—"}</td>
              <td className="px-4 py-4 text-xs text-slate-600 dark:text-slate-300">
                <div>{item.label ?? item.sourceId}</div>
                <div className="text-slate-500 dark:text-slate-400">
                  {item.revisionCount ?? 0} revision{(item.revisionCount ?? 0) === 1 ? "" : "s"}
                  {item.isPrimary && <span className="ml-2 text-emerald-600 dark:text-emerald-400">Primary</span>}
                </div>
              </td>
              <td className="px-4 py-4 text-xs text-slate-600 dark:text-slate-300">
                {formatDate(item.lastContributionAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Pagination
        currentPage={currentPage}
        totalItems={total}
        itemsPerPage={itemsPerPage}
        onPageChange={handlePageChange}
      />
    </section>
  );
}
