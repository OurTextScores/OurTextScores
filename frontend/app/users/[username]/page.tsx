import type { Metadata } from "next";
import {
  fetchPublicUserByUsername,
  fetchUserContributions
} from "../../lib/api";
import UserContributionsTable from "./user-contributions-table";

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

        <UserContributionsTable
          contributions={contributions}
          total={contributionsResponse.total}
          currentPage={page}
          itemsPerPage={ITEMS_PER_PAGE}
        />
      </section>
    </main>
  );
}
