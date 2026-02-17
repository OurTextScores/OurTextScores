import Link from "next/link";
import SignInForm from "./signin-form";

export const metadata = {
  title: "Sign In | OurTextScores",
  description: "Sign in to access the OurTextScores beta."
};

export default function SignInPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const next = typeof searchParams?.next === "string" ? searchParams.next : "";
  const errorCode = typeof searchParams?.error === "string" ? searchParams.error : "";
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const githubEnabled = Boolean(process.env.GITHUB_ID && process.env.GITHUB_SECRET);

  return (
    <main className="min-h-screen bg-slate-50 py-10 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <section className="mx-auto w-full max-w-xl space-y-6 px-6">
        <header className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <h1 className="text-2xl font-semibold">Sign in</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Sign in with your approved account. If you were invited, activate your invite link first.
          </p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Need access?{" "}
            <Link href="/beta-preview" className="text-cyan-700 underline hover:text-cyan-800 dark:text-cyan-300">
              Request beta access
            </Link>
            .
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/60">
          <SignInForm
            initialNext={next}
            googleEnabled={googleEnabled}
            githubEnabled={githubEnabled}
            initialErrorCode={errorCode}
          />
        </section>
      </section>
    </main>
  );
}
