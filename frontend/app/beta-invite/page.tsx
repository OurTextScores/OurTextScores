import BetaInviteClient from "./beta-invite-client";

export const metadata = {
  title: "Beta Invite | OurTextScores",
  description: "Activate your OurTextScores beta invite."
};

export default function BetaInvitePage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const token = typeof searchParams?.token === "string" ? searchParams.token : "";

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto w-full max-w-xl space-y-6 px-6">
        <header className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <h1 className="text-2xl font-semibold">Beta Invite Activation</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Activate your invite to create account access, then sign in using Google or GitHub.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <BetaInviteClient token={token} />
        </section>
      </section>
    </main>
  );
}
