import BetaApproveClient from "./beta-approve-client";

export const metadata = {
  title: "Approve Beta Request | OurTextScores",
  description: "Review a beta access request and send an invite.",
};

export default function BetaApprovePage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const token = typeof searchParams?.token === "string" ? searchParams.token : "";

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto w-full max-w-2xl px-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <h1 className="text-2xl font-semibold">Approve Beta Request</h1>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            Review the request and explicitly send the requester their existing beta invite.
          </p>
          <div className="mt-6">
            <BetaApproveClient token={token} />
          </div>
        </div>
      </section>
    </main>
  );
}
