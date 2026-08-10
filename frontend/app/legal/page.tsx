import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Legal | OurTextScores",
  description:
    "Terms of Service, Privacy Policy, and DMCA information for OurTextScores.",
};

export default function LegalPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Legal
      </h1>
      {/* The scanner stamps every stored correction with the version of these
          terms in force when it was captured, so answers given under earlier
          wording stay distinguishable. That is only meaningful if the version
          is something a reader can see, hence the date. Keep it in step with
          SCANNER_TRAINING_POLICY_VERSION. */}
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Last updated 10 August 2026
      </p>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Terms of Service
        </h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <p>
            By using OurTextScores, you agree not to upload unlawful content and
            to upload only material you are authorized to share.
          </p>
          <p>
            You remain responsible for rights and licensing information attached
            to your uploads. OurTextScores may remove or disable content based
            on legal notices, policy violations, or abuse mitigation.
          </p>
          <p>
            Repeat infringers may be suspended or terminated. Accounts may also
            be restricted for abuse, fraud, or security reasons.
          </p>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Privacy Policy
        </h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <p>
            OurTextScores collects account identifiers, contribution metadata,
            and operational logs needed to run the service, moderate abuse, and
            process legal notices.
          </p>
          <p>
            We use this information for authentication, attribution,
            notifications, and platform safety workflows including DMCA/takedown
            handling.
          </p>
          <p>
            We may retain compliance and audit records as required for legal and
            security operations.
          </p>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          DMCA Policy
        </h2>
        <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
          OurTextScores responds to copyright notices and counter-notices in
          good faith. This section describes how to submit a notice and what
          information is required.
        </p>

        <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            Submit a Notice
          </h3>
          <p>Please include:</p>
          <ul className="list-disc space-y-1 pl-6">
            <li>Your full legal name and contact email.</li>
            <li>The specific OurTextScores content you claim is infringing.</li>
            <li>A statement of good-faith belief that use is unauthorized.</li>
            <li>
              A statement under penalty of perjury that your notice is accurate
              and you are authorized.
            </li>
            <li>Your physical or electronic signature.</li>
          </ul>
        </div>

        <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            Submit a Counter-Notice
          </h3>
          <p>
            If your content was disabled by mistake or misidentification, you
            may submit a counter-notice that includes your
            identification/contact information, a statement under penalty of
            perjury, and consent to jurisdiction as required by law.
          </p>
        </div>

        <div className="mt-4 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            DMCA Contact
          </h3>
          <p>
            Email:{" "}
            <a
              href="mailto:dmca@ourtextscores.com"
              className="text-cyan-700 underline dark:text-cyan-300"
            >
              dmca@ourtextscores.com
            </a>
          </p>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Open Source and Attribution
        </h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <p>
            OurTextScores is free software distributed under the{" "}
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.en.html"
              className="text-cyan-700 underline dark:text-cyan-300"
              rel="noreferrer noopener"
              target="_blank"
            >
              GNU Affero General Public License, version 3
            </a>
            . Because AGPL section 13 covers software you interact with over a
            network, the corresponding source of the services described here is
            published rather than merely available on request.
          </p>

          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            Scanner and HOMR
          </h3>
          <p>
            The Scanner feature performs optical music recognition with{" "}
            <a
              href="https://github.com/liebharc/homr"
              className="text-cyan-700 underline dark:text-cyan-300"
              rel="noreferrer noopener"
              target="_blank"
            >
              HOMR
            </a>
            , which is licensed under AGPL-3.0 and is copyright its own authors.
            OurTextScores runs a modified, authenticated wrapper around it as a
            separate inference service; that wrapper is also AGPL-3.0-or-later.
          </p>
          <p>
            The exact deployed revision, the HOMR commit, and the SHA-256 of
            every model file in use are reported by the inference
            service&rsquo;s{" "}
            <code className="font-mono text-xs">/v1/capabilities</code>{" "}
            endpoint, together with a link to the corresponding source.
          </p>

          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            Scanner data handling
          </h3>
          <p>
            Pages you scan leave OurTextScores and are sent to that inference
            service for processing. The service does not retain them after a
            request completes. Within OurTextScores, uploaded source pages are
            kept for 7 days and scan results for 30 days, after which both are
            deleted automatically. You can delete a scan and everything
            belonging to it at any time from its result page.
          </p>
          <p>
            Scans are private to the account that created them and are never
            added to the public catalogue automatically.
          </p>
          <p>
            Where the scanner is unsure about a symbol, it may ask you to
            confirm or correct it. If you answer, we keep what the scanner
            predicted, the alternatives it offered, and which you chose, so that
            recognition can be improved. That record identifies the passage, not
            its contents: it holds no image, no notation, and no part of your
            score. Your scanned pages themselves are not used to train any
            model, and answering is entirely optional — you can skip any
            question, or ignore the review altogether.
          </p>
          <p>
            Scanner output is a machine-generated draft. Recognition can misread
            notes, rhythms, voices, lyrics, and page-boundary notation, and
            results are not published to the catalogue unless you choose to
            upload them through the normal contribution flow.
          </p>
        </div>
      </section>
    </main>
  );
}
