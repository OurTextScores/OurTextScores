import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | OurTextScores",
  description: "Terms of Service for using OurTextScores."
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Terms of Service</h1>
      <div className="mt-4 space-y-4 text-sm text-slate-700 dark:text-slate-300">
        <p>
          By using OurTextScores, you agree not to upload unlawful content and to upload only material you are
          authorized to share.
        </p>
        <p>
          You remain responsible for rights and licensing information attached to your uploads. OurTextScores may
          remove or disable content based on legal notices, policy violations, or abuse mitigation.
        </p>
        <p>
          Repeat infringers may be suspended or terminated. Accounts may also be restricted for abuse, fraud, or
          security reasons.
        </p>
        <p>
          This page is a product-level policy summary and should be supplemented with finalized legal text before
          production launch.
        </p>
      </div>
    </main>
  );
}
