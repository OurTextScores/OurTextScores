import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | OurTextScores",
  description: "Privacy policy for OurTextScores."
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Privacy Policy</h1>
      <div className="mt-4 space-y-4 text-sm text-slate-700 dark:text-slate-300">
        <p>
          OurTextScores collects account identifiers, contribution metadata, and operational logs needed to run the
          service, moderate abuse, and process legal notices.
        </p>
        <p>
          We use this information for authentication, attribution, notifications, and platform safety workflows
          including DMCA/takedown handling.
        </p>
        <p>
          We may retain compliance and audit records as required for legal and security operations.
        </p>
      </div>
    </main>
  );
}
