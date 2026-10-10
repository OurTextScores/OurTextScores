import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../../lib/server-session";
import LyricReviewClient from "./lyric-review-client";

/** Review-assisted lyric placement; off unless the flag is set at build time. */
export default async function LyricReviewPage() {
  const session = await fetchBackendSession();
  if (!session?.user)
    redirect("/signin?callbackUrl=%2Fscanner%2Flyric-review");

  if (process.env.NEXT_PUBLIC_OTS_HOMR_LYRIC_REVIEW_ENABLED !== "1") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
          Lyric and staff text review
        </h1>
        <p className="mt-4 text-slate-600 dark:text-slate-400">
          Lyric and staff text review is not enabled for this deployment.
        </p>
        <Link
          href="/scanner"
          className="mt-6 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Back to the scanner
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="mb-4 text-3xl font-bold text-slate-900 dark:text-slate-100">
        Lyric placement review
      </h1>
      <LyricReviewClient
        baseUrl={
          process.env.NEXT_PUBLIC_OTS_HOMR_LYRIC_REVIEW_BASE ?? "/lyric-review"
        }
      />
    </main>
  );
}
