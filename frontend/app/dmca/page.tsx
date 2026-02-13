import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DMCA Policy | OurTextScores",
  description: "DMCA notice and counter-notice process for OurTextScores."
};

export default function DmcaPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">DMCA Policy</h1>
      <p className="mt-4 text-sm text-slate-700 dark:text-slate-300">
        OurTextScores responds to copyright notices and counter-notices in good faith. This page describes how to
        submit a notice and what information is required.
      </p>

      <section className="mt-6 space-y-3 text-sm text-slate-700 dark:text-slate-300">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Submit a Notice</h2>
        <p>Please include:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>Your full legal name and contact email.</li>
          <li>The specific OurTextScores content you claim is infringing.</li>
          <li>A statement of good-faith belief that use is unauthorized.</li>
          <li>A statement under penalty of perjury that your notice is accurate and you are authorized.</li>
          <li>Your physical or electronic signature.</li>
        </ul>
      </section>

      <section className="mt-6 space-y-3 text-sm text-slate-700 dark:text-slate-300">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Submit a Counter-Notice</h2>
        <p>
          If your content was disabled by mistake or misidentification, you may submit a counter-notice that includes
          your identification/contact information, a statement under penalty of perjury, and consent to jurisdiction as
          required by law.
        </p>
      </section>

      <section className="mt-6 space-y-3 text-sm text-slate-700 dark:text-slate-300">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">DMCA Contact</h2>
        <p>
          Email: <a href="mailto:dmca@ourtextscores.com" className="text-cyan-700 underline dark:text-cyan-300">dmca@ourtextscores.com</a>
        </p>
        <p>
          A designated agent registration and mailing address should be maintained and published for production
          operations.
        </p>
      </section>
    </main>
  );
}
