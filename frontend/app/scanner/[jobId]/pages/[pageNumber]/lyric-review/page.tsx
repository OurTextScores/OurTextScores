import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../../../../../lib/server-session";
import LyricCandidatesClient from "./lyric-candidates-client";

/** Review-assisted lyric text for one scanned page; off unless the flag is set. */
export default async function LyricCandidatesPage({
  params,
}: {
  params: { jobId: string; pageNumber: string };
}) {
  const session = await fetchBackendSession();
  const target = `/scanner/${params.jobId}/pages/${params.pageNumber}/lyric-review`;
  if (!session?.user) redirect(`/signin?callbackUrl=${encodeURIComponent(target)}`);
  const pageNumber = Number(params.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    redirect(`/scanner/${params.jobId}`);
  }

  const enabled = process.env.NEXT_PUBLIC_OTS_HOMR_LYRIC_REVIEW_ENABLED === "1";
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link
        href={`/scanner/${params.jobId}`}
        className="mb-5 inline-block text-sm text-slate-600 hover:underline dark:text-slate-400"
      >
        ← Back to the scan
      </Link>
      <h1 className="mb-4 text-3xl font-bold text-slate-900 dark:text-slate-100">
        Lyric review — page {pageNumber}
      </h1>
      {enabled ? (
        <LyricCandidatesClient jobId={params.jobId} pageNumber={pageNumber} />
      ) : (
        <p className="text-slate-600 dark:text-slate-400">
          Lyric review is not enabled for this deployment.
        </p>
      )}
    </main>
  );
}
