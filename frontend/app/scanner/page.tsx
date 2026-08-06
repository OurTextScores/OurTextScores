import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../lib/server-session";
import ScannerClient from "./scanner-client";

export default async function ScannerPage() {
  const session = await fetchBackendSession();
  if (!session?.user) redirect("/signin?callbackUrl=%2Fscanner");

  if (
    process.env.SCANNER_ENABLED !== "true" &&
    process.env.NEXT_PUBLIC_SCANNER_ENABLED !== "true"
  ) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
          Scanner
        </h1>
        <p className="mt-4 text-slate-600 dark:text-slate-400">
          The scanner pilot is not enabled for this deployment.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Return home
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
          Scanner
        </h1>
        <p className="mt-2 max-w-3xl text-slate-600 dark:text-slate-400">
          Convert printed sheet music to MusicXML with HOMR. Results remain
          separate from the catalogue; download them here and upload them to a
          work manually if you choose.
        </p>
        <div className="mt-4 max-w-3xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Scanner output is a draft and may contain significant notation errors.
          Review every result before relying on it.
        </div>
        <p className="mt-3 max-w-3xl text-xs leading-5 text-slate-500 dark:text-slate-400">
          Score pages are sent to the configured external inference provider.
          Source pages are retained for 7 days and results for 30 days unless
          you delete the scan sooner. Only scan material you are permitted to
          process; see the{" "}
          <Link
            href="/legal"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            privacy and rights guidance
          </Link>
          .
        </p>
      </div>
      <ScannerClient />
    </main>
  );
}
