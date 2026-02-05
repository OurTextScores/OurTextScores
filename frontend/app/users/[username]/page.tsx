import Link from "next/link";
import type { Metadata } from "next";
import {
  fetchPublicUserByUsername,
  fetchUserContributions,
  UserContribution
} from "../../lib/api";

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

const ITEMS_PER_PAGE = 50;

export async function generateMetadata({
  params
}: {
  params: { username: string };
}): Promise<Metadata> {
  const username = params.username;
  return {
    title: `${username} | Contributors | OurTextScores`
  };
}

export default async function UserProfilePage({
  params,
  searchParams
}: {
  params: { username: string };
  searchParams: { page?: string };
}) {
  const username = params.username;
  const page = Math.max(parseInt(searchParams.page ?? "1", 10) || 1, 1);
  const offset = (page - 1) * ITEMS_PER_PAGE;

  const user = await fetchPublicUserByUsername(username);
  const contributionsResponse = await fetchUserContributions(user.id, {
    limit: ITEMS_PER_PAGE,
    offset
  });

  const totalPages = Math.max(Math.ceil(contributionsResponse.total / ITEMS_PER_PAGE), 1);
  const contributions = contributionsResponse.contributions;

  return (
    <main className="min-h-screen bg-slate-50 py-12 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Contributor</p>
          <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">
            {user.displayName ?? user.username}
          </h1>
          {user.displayName && (
            <p className="text-sm text-slate-600 dark:text-slate-300">@{user.username}</p>
          )}
        </header>

        <section className="rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              Sources contributed to
            </h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {contributionsResponse.total} total sources
            </p>
          </div>
          {contributions.length === 0 ? (
            <div className="px-5 py-6 text-sm text-slate-500 dark:text-slate-400">
              No contributions yet.
            </div>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {contributions.map((item: UserContribution) => (
                <li key={`${item.workId}-${item.sourceId}`} className="px-5 py-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-1">
                      <Link
                        href={`/works/${encodeURIComponent(item.workId)}?source=${encodeURIComponent(item.sourceId)}`}
                        className="text-base font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
                      >
                        {item.workTitle ?? item.workId}
                      </Link>
                      <div className="text-sm text-slate-600 dark:text-slate-300">
                        {item.workComposer ?? "Unknown composer"}
                        {item.workCatalogNumber && (
                          <span className="ml-2 text-slate-400 dark:text-slate-500">
                            • {item.workCatalogNumber}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Source: {item.label ?? item.sourceId}
                        {item.isPrimary && <span className="ml-2 text-emerald-600 dark:text-emerald-400">Primary</span>}
                      </div>
                    </div>
                    <div className="text-right text-xs text-slate-500 dark:text-slate-400">
                      <div>Last contribution: {formatDate(item.lastContributionAt)}</div>
                      {item.revisionCount !== undefined && (
                        <div>{item.revisionCount} revision{item.revisionCount === 1 ? "" : "s"}</div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-3">
              {page > 1 && (
                <Link
                  href={`/users/${encodeURIComponent(username)}?page=${page - 1}`}
                  className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={`/users/${encodeURIComponent(username)}?page=${page + 1}`}
                  className="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Next
                </Link>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
