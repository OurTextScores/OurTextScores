import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchUserByUsername, fetchUserUploads } from "../../lib/api";

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default async function UserProfilePage({
  params,
  searchParams
}: {
  params: { username: string };
  searchParams?: { page?: string };
}) {
  const { username } = params;
  const page = Number(searchParams?.page ?? "1");
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;
  const limit = 20;
  const offset = (safePage - 1) * limit;

  const profile = await fetchUserByUsername(username).catch(() => notFound());
  const uploads = await fetchUserUploads(profile.id, { limit, offset });

  const { stats, sources, recentRevisions } = uploads;
  const hasNextPage = stats.sourceCount > offset + sources.length;
  const hasPrevPage = safePage > 1;

  const title = profile.username ? `@${profile.username}` : profile.displayName || "User";

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6">
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              <Link href="/" className="underline-offset-2 hover:underline">
                ← Back to works
              </Link>
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
            {profile.displayName && (
              <p className="text-sm text-slate-500 dark:text-slate-400">{profile.displayName}</p>
            )}
            {profile.username && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">
                Public profile for username <span className="font-mono">@{profile.username}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-300">
            <span className="rounded-full bg-slate-100 px-3 py-1 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
              Sources <span className="font-semibold">{stats.sourceCount}</span>
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
              Revisions <span className="font-semibold">{stats.revisionCount}</span>
            </span>
            <span className="rounded-full bg-slate-100 px-3 py-1 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
              Works <span className="font-semibold">{stats.workCount}</span>
            </span>
          </div>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="mb-3 text-lg font-semibold text-slate-800 dark:text-slate-100">Uploaded sources</h2>
          {sources.length === 0 ? (
            <p className="text-slate-600 dark:text-slate-400">This user has not uploaded any sources yet.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-xs dark:divide-slate-800">
                  <thead className="bg-slate-100 text-left uppercase tracking-wider text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Work</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">Latest revision</th>
                      <th className="px-3 py-2">Primary</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {sources.map((src) => (
                      <tr key={src.sourceId} className="hover:bg-slate-50 dark:hover:bg-slate-800/20">
                        <td className="px-3 py-2 align-top">
                          <div className="text-slate-800 dark:text-slate-200">
                            {src.workTitle || src.workId}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {src.workComposer || "—"}
                          </div>
                          {src.workCatalogNumber && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-500">
                              {src.workCatalogNumber}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="text-slate-800 dark:text-slate-200">{src.label}</div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {src.format}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="text-slate-800 dark:text-slate-200">
                            {src.latestRevisionId ? (
                              <code className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                {src.latestRevisionId}
                              </code>
                            ) : (
                              "—"
                            )}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            {formatDate(src.latestRevisionAt)}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          {src.isPrimary ? (
                            <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-700 ring-1 ring-cyan-200 dark:bg-cyan-500/20 dark:text-cyan-300 dark:ring-cyan-400/40">
                              Primary
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500 dark:text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <Link
                            href={`/works/${encodeURIComponent(src.workId)}`}
                            className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                          >
                            View work
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(hasPrevPage || hasNextPage) && (
                <div className="mt-3 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                  <div>
                    Showing{" "}
                    <span className="font-semibold">
                      {offset + 1}–{offset + sources.length}
                    </span>{" "}
                    of <span className="font-semibold">{stats.sourceCount}</span> sources
                  </div>
                  <div className="flex gap-2">
                    {hasPrevPage && (
                      <Link
                        href={`/users/${encodeURIComponent(username)}?page=${safePage - 1}`}
                        className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                      >
                        Previous
                      </Link>
                    )}
                    {hasNextPage && (
                      <Link
                        href={`/users/${encodeURIComponent(username)}?page=${safePage + 1}`}
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

        <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-lg dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="mb-3 text-lg font-semibold text-slate-800 dark:text-slate-100">Recent revisions</h2>
          {recentRevisions.length === 0 ? (
            <p className="text-slate-600 dark:text-slate-400">No recent revisions for this user.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs dark:divide-slate-800">
                <thead className="bg-slate-100 text-left uppercase tracking-wider text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Work</th>
                    <th className="px-3 py-2">Revision</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Summary</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {recentRevisions.map((rev) => (
                    <tr key={rev.revisionId} className="hover:bg-slate-50 dark:hover:bg-slate-800/20">
                      <td className="px-3 py-2 align-top">
                        <div className="text-slate-800 dark:text-slate-200">
                          {rev.workTitle || rev.workId}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <code className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                          {rev.revisionId}
                        </code>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          Seq #{rev.sequenceNumber}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="text-slate-800 dark:text-slate-200">
                          {formatDate(rev.createdAt)}
                        </div>
                      </td>
                      <td className="px-3 py-2 max-w-[18rem] align-top">
                        <div
                          className="truncate text-slate-700 dark:text-slate-300"
                          title={rev.changeSummary || ""}
                        >
                          {rev.changeSummary || "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Link
                          href={`/works/${encodeURIComponent(rev.workId)}`}
                          className="text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                        >
                          View work
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

