import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Legal | OurTextScores",
  description: "Terms of Service, Privacy Policy, and DMCA information for OurTextScores."
};

export default function LegalPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Legal</h1>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Terms of Service</h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
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
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Privacy Policy</h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
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
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">DMCA Policy</h2>
        <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
          OurTextScores responds to copyright notices and counter-notices in good faith. This section describes how to
          submit a notice and what information is required.
        </p>

        <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">Submit a Notice</h3>
          <p>Please include:</p>
          <ul className="list-disc space-y-1 pl-6">
            <li>Your full legal name and contact email.</li>
            <li>The specific OurTextScores content you claim is infringing.</li>
            <li>A statement of good-faith belief that use is unauthorized.</li>
            <li>A statement under penalty of perjury that your notice is accurate and you are authorized.</li>
            <li>Your physical or electronic signature.</li>
          </ul>
        </div>

        <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">Submit a Counter-Notice</h3>
          <p>
            If your content was disabled by mistake or misidentification, you may submit a counter-notice that includes
            your identification/contact information, a statement under penalty of perjury, and consent to jurisdiction as
            required by law.
          </p>
        </div>

        <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">DMCA Contact</h3>
          <p>
            Email:{" "}
            <a href="mailto:dmca@ourtextscores.com" className="text-cyan-700 underline dark:text-cyan-300">
              dmca@ourtextscores.com
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
