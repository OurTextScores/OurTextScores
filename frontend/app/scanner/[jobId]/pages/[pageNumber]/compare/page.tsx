import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../../../../../lib/server-session";
import { isPublicScannerJob } from "../../../../../lib/public-examples";
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
  searchParams,
}: {
  params: { jobId: string; pageNumber: string };
  searchParams: { base?: string; candidate?: string };
}) {
  const session = await fetchBackendSession();
  const target = `/scanner/${params.jobId}/pages/${params.pageNumber}/compare`;
  if (!session?.user && !isPublicScannerJob(params.jobId)) {
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
      <ComparePageClient
        jobId={params.jobId}
        pageNumber={pageNumber}
        initialBaseEngine={searchParams.base}
        initialCandidateEngine={searchParams.candidate}
      />
      {/*
        The way out, again, at the end.

        Three scores stacked over a scan run to several screens, and a reviewer
        who has walked to the last line of a page is thousands of pixels from
        the link at the top — so leaving meant scrolling back past everything
        they had just decided.

        It says the same thing as the link above rather than offering to save:
        every decision and hand correction is already written as it is made, and
        the scan is rebuilt from the merged score on the way. A button here
        promising to sync would invent a step that does not exist, and imply
        that the work is not safe until it is pressed.
      */}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-5 dark:border-slate-800">
        <Link
          href={`/scanner/${params.jobId}`}
          className="text-sm text-slate-600 hover:underline dark:text-slate-400"
        >
          ← Back to the scan
        </Link>
        <span className="text-xs text-slate-500 dark:text-slate-500">
          Merged changes are saved as you make them, and the scan is rebuilt
          from them.
        </span>
      </div>
    </main>
  );
}
