import Link from "next/link";
import { searchUsers } from "../lib/api";

export default async function UsersIndexPage({
  searchParams
}: {
  searchParams?: { q?: string; page?: string };
}) {
  const query = (searchParams?.q || "").trim();
  const page = Number(searchParams?.page ?? "1");
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const limit = 20;
  const offset = (safePage - 1) * limit;

  const results = query ? await searchUsers(query, { limit, offset }) : null;
  const total = results?.total ?? 0;
  const users = results?.users ?? [];
  const hasNext = total > offset + users.length;
  const hasPrev = safePage > 1;

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto w-full max-w-3xl px-6">
        <h1 className="mb-4 text-2xl font-semibold">Users</h1>

        <form className="mb-4 flex flex-wrap gap-2 text-sm" action="/users" method="get">
          <input
            type="text"
            name="q"
            defaultValue={query}
            placeholder="Search by username"
            className="min-w-[12rem] flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
          />
          <button
            type="submit"
            className="rounded bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700"
          >
            Search
          </button>
        </form>

        {!query && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Search for a user by username to view their public profile and uploads.
          </p>
        )}

        {query && (
          <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <h2 className="mb-3 text-base font-semibold text-slate-800 dark:text-slate-100">
              Results for “{query}”
            </h2>
            {users.length === 0 ? (
              <p className="text-slate-600 dark:text-slate-400">No users found.</p>
            ) : (
              <>
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {users.map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                      <div>
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          @{u.username}
                        </div>
                        {u.displayName && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {u.displayName}
                          </div>
                        )}
                      </div>
                      <Link
                        href={`/users/${encodeURIComponent(u.username)}`}
                        className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                      >
                        View profile
                      </Link>
                    </li>
                  ))}
                </ul>
                {(hasPrev || hasNext) && (
                  <div className="mt-3 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                    <div>
                      Showing{" "}
                      <span className="font-semibold">
                        {offset + 1}–{offset + users.length}
                      </span>{" "}
                      of <span className="font-semibold">{total}</span> users
                    </div>
                    <div className="flex gap-2">
                      {hasPrev && (
                        <Link
                          href={`/users?q=${encodeURIComponent(query)}&page=${safePage - 1}`}
                          className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                        >
                          Previous
                        </Link>
                      )}
                      {hasNext && (
                        <Link
                          href={`/users?q=${encodeURIComponent(query)}&page=${safePage + 1}`}
                          className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                        >
                          Next
                        </Link>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

