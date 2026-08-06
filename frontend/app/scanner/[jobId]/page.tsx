import Link from "next/link";
import { redirect } from "next/navigation";
import { fetchBackendSession } from "../../lib/server-session";
import ScannerJobClient from "./scanner-job-client";

export default async function ScannerJobPage({ params }: { params: { jobId: string } }) {
  const session = await fetchBackendSession();
  if (!session?.user) {
    redirect(`/signin?callbackUrl=${encodeURIComponent(`/scanner/${params.jobId}`)}`);
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <Link href="/scanner" className="mb-5 inline-block text-sm text-slate-600 hover:underline dark:text-slate-400">
        ← All scans
      </Link>
      <ScannerJobClient jobId={params.jobId} />
    </main>
  );
}
