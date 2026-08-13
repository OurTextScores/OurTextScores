import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../../../../../lib/server-session";
import ComparePageClient from "./compare-client";

/**
 * The comparison, on a page of its own.
 *
 * It used to expand inside the job page's card, where three scores stacked over
 * a scan competed for width with that page's downloads and previews, below a
 * fold that grew as the readings loaded. A page also gives a comparison a URL:
 * a reviewer can come back to a difference, or send it to someone.
 */
export default async function ComparePage({
  params,
}: {
  params: { jobId: string; pageNumber: string };
}) {
  const session = await fetchBackendSession();
  const target = `/scanner/${params.jobId}/pages/${params.pageNumber}/compare`;
  if (!session?.user) {
    redirect(`/signin?callbackUrl=${encodeURIComponent(target)}`);
  }
  const pageNumber = Number(params.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    redirect(`/scanner/${params.jobId}`);
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <Link
        href={`/scanner/${params.jobId}`}
        className="mb-5 inline-block text-sm text-slate-600 hover:underline dark:text-slate-400"
      >
        ← Back to the scan
      </Link>
      <ComparePageClient jobId={params.jobId} pageNumber={pageNumber} />
    </main>
  );
}
