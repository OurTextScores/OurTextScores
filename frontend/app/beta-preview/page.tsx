import Link from "next/link";
import BetaPreviewForm from "./beta-preview-form";

export const metadata = {
  title: "Beta Preview | OurTextScores",
  description: "OurTextScores is currently in beta preview. Request access."
};

export default function BetaPreviewPage() {
  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto w-full max-w-3xl space-y-6 px-6">
        <header className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-300">
            Beta Preview
          </p>
          <h1 className="mt-2 text-2xl font-semibold">OurTextScores is currently in beta preview</h1>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            We are temporarily limiting access while legal and policy pages are finalized.
            Request access below and tell us how you plan to use the platform.
          </p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            You can still read the public overview at{" "}
            <Link href="/welcome" className="text-cyan-700 underline hover:text-cyan-800 dark:text-cyan-300">
              /welcome
            </Link>
            .
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="mb-4 text-lg font-semibold">Request Access</h2>
          <BetaPreviewForm />
        </section>
      </section>
    </main>
  );
}
