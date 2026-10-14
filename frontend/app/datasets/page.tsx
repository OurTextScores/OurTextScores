import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { Section } from "../ots-homr/ui";
import corpora from "./corpora.json";

export const metadata: Metadata = {
  title: "Datasets | OurTextScores",
  description:
    "Download the OTS-HOMR staff-crop datasets, explore their source archives, and reproduce the data and scanner recipes.",
};

const link = "text-blue-600 hover:underline dark:text-blue-400";
const recipeRoot =
  "https://github.com/OurTextScores/homr/tree/a7fbe13b2ca7575bfd185e1ac131ed8144057b67";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={link} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function size(bytes: number) {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

const huggingFace = [
  {
    name: "OSSQ scanned-corrected · v1",
    repository: "jhlusko/ossq-omr-data",
    revision: "fc81cfe8f313a01e2574447cf51990785230cb3b",
    description:
      "A portable historical staff-crop archive: 34,510 training and 3,911 validation rows, grouped by quartet system. This is a different release from the OSSQ v2 shards above.",
  },
  {
    name: "Lieder source provenance",
    repository: "jhlusko/lieder-omr-private-all-sources",
    revision: "1f0cef0a83602784409f5fd614e52b5c0b9bf035",
    description:
      "Source-file records, rights-audit ledgers and reconstruction indexes for all 215 historical IMSLP inputs. This repository contains provenance files, rather than scan PDFs or staff-crop images; use the Lieder R2 release for the built crops.",
  },
  {
    name: "GrandStaff LMX",
    repository: "jhlusko/grandstaff_lmx",
    revision: "e7127b4e8e30e78fbb91f9e2d17a87c8b227a1b8",
    description:
      "Grand-staff images with LMX, MusicXML and kern representations, including distorted images. Training, development and test batches are recorded in the dataset card.",
  },
  {
    name: "OLiMPiC · scanned",
    repository: "jhlusko/olimpic_scanned",
    revision: "c85144e488daf999ef0437fdabe26cf438e910fa",
    description:
      "Scanned piano staff images paired with LMX and MusicXML, packaged as Parquet batches. See the card for the original OLiMPiC source and citation.",
  },
  {
    name: "OLiMPiC · synthetic",
    repository: "jhlusko/olimpic_synthetic",
    revision: "454f6dc8dea0cb64db66e716bc4d61989d734cbd",
    description:
      "Rendered piano staff images paired with LMX and MusicXML. These batches are separate from the scanned OLiMPiC archive and the Lieder v8 training release.",
  },
];

export default function DatasetsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Research and reproducibility
      </p>
      <h1 className="mt-1 text-3xl font-semibold text-slate-900 dark:text-slate-100">
        Datasets
      </h1>
      <p className="mt-3 max-w-3xl text-base leading-7 text-slate-700 dark:text-slate-300">
        The data behind <Link href="/ots-homr" className={link}>OTS-HOMR</Link>:
        scanned and rendered staff images, their musical transcriptions, and
        structured notation labels. Download a built corpus to train or
        evaluate a model, or use its source repository to reconstruct the data.
      </p>
      <nav aria-label="Datasets page sections" className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <a href="#corpora" className={link}>Staff-crop downloads</a>
        <a href="#hugging-face" className={link}>Hugging Face archives</a>
        <a href="#data-recipe" className={link}>Data recipe</a>
        <a href="#scanner-recipe" className={link}>Scanner recipe</a>
      </nav>

      <Section id="corpora" title="Staff-crop downloads" wide>
        <p>
          Each window contains an image, recognition tokens and a structured-notation
          sidecar. These releases use <code>homr.notation-sidecar.v6</code>.
          Train and validation scores are kept separate. The GitHub repositories
          contain the build and verification tools; Cloudflare R2 hosts the compressed data.
        </p>
        <div className="grid min-w-0 gap-5 lg:grid-cols-2">
          {corpora.map((corpus) => (
            <article
              key={corpus.id}
              aria-labelledby={`${corpus.id}-title`}
              className="min-w-0 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
            >
              <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {corpus.kind}
              </p>
              <h3 id={`${corpus.id}-title`} className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                {corpus.title}
              </h3>
              <p className="mt-1 break-words font-mono text-xs text-slate-500 dark:text-slate-400">
                {corpus.version}
              </p>
              <p className="mt-3">{corpus.description}</p>
              <dl className="my-4 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Train crops</dt>
                  <dd className="font-semibold tabular-nums">{corpus.splits.train.windows.toLocaleString("en-US")}</dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Validation</dt>
                  <dd className="font-semibold tabular-nums">{corpus.splits.valid.windows.toLocaleString("en-US")}</dd>
                </div>
                <div>
                  <dt className="text-slate-500 dark:text-slate-400">Compressed</dt>
                  <dd className="font-semibold tabular-nums">{size(corpus.shards.reduce((total, shard) => total + shard.bytes, 0))}</dd>
                </div>
              </dl>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {corpus.splits.train.scores.toLocaleString("en-US")} training scores ·{" "}
                {corpus.splits.valid.scores.toLocaleString("en-US")} validation scores
              </p>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                <ExternalLink href={corpus.repository}>Build repository</ExternalLink>
                <ExternalLink href={corpus.lock}>{corpus.id === "pdmx-v2" ? "Versioned build recipe" : "Pinned source lock"}</ExternalLink>
                <ExternalLink href={corpus.manifest}>R2 release manifest</ExternalLink>
                <ExternalLink href={corpus.source}>Original source</ExternalLink>
              </div>
              {corpus.trainIndex && corpus.validIndex && (
                <p className="mt-3 text-xs">
                  Ordered indexes: <ExternalLink href={corpus.trainIndex}>train</ExternalLink>{" "}
                  · <ExternalLink href={corpus.validIndex}>validation</ExternalLink>
                </p>
              )}
              <details className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
                <summary className="cursor-pointer font-medium text-slate-800 dark:text-slate-200">
                  Download archives ({corpus.shards.length} shards)
                </summary>
                <div className="mt-3 max-h-96 overflow-auto rounded border border-slate-200 dark:border-slate-700" tabIndex={0} aria-label={`${corpus.title} archive downloads`}>
                  <table className="w-full text-left text-xs">
                    <caption className="sr-only">{corpus.title} archives and SHA-256 checksums</caption>
                    <thead className="bg-slate-50 dark:bg-slate-800">
                      <tr>
                        <th scope="col" className="px-3 py-2">Archive / SHA-256</th>
                        <th scope="col" className="px-3 py-2">Split</th>
                        <th scope="col" className="px-3 py-2">Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {corpus.shards.map((shard) => (
                        <tr key={shard.name} className="border-t border-slate-200 dark:border-slate-700">
                          <td className="px-3 py-2">
                            <ExternalLink href={shard.url}>{shard.name}</ExternalLink>
                            <code className="mt-1 block break-all text-[10px] text-slate-500 dark:text-slate-400">{shard.sha256}</code>
                          </td>
                          <td className="px-3 py-2 align-top">{shard.split === "valid" ? "Validation" : "Train"}</td>
                          <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums">{size(shard.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </article>
          ))}
        </div>
      </Section>

      <Section id="hugging-face" title="Hugging Face archives">
        <p>
          These are separately versioned archives and source records. Use their
          dataset cards to select the right release; the historical OSSQ archive
          and the R2 v2 corpus have different training-row counts.
        </p>
        <div className="space-y-5">
          {huggingFace.map((dataset) => (
            <article key={dataset.repository} className="border-l-2 border-slate-200 pl-4 dark:border-slate-700">
              <h3 className="font-semibold text-slate-900 dark:text-slate-100">
                <ExternalLink href={`https://huggingface.co/datasets/${dataset.repository}`}>{dataset.name}</ExternalLink>
              </h3>
              <p className="mt-1">{dataset.description}</p>
              <p className="mt-1 text-xs">
                <ExternalLink href={`https://huggingface.co/datasets/${dataset.repository}/tree/${dataset.revision}`}>Browse this archive version</ExternalLink>
              </p>
            </article>
          ))}
        </div>
        <p>
          <ExternalLink href="https://huggingface.co/datasets/jhlusko/ossq-omr-data/resolve/fc81cfe8f313a01e2574447cf51990785230cb3b/ossq-scanned-corrected-v1.tar.gz">
            Download the OSSQ v1 archive (794 MB)
          </ExternalLink>{" "}
          · <ExternalLink href="https://huggingface.co/datasets/jhlusko/ossq-omr-data/blob/fc81cfe8f313a01e2574447cf51990785230cb3b/MANIFEST.json">Unpacked-tree manifest</ExternalLink>
        </p>
      </Section>

      <Section id="data-recipe" title="Reproduce the data">
        <ol className="ml-5 list-decimal space-y-3">
          <li><strong>Choose a version.</strong> Use the release named by your training recipe. Keep its source lock, indexes and sidecar schema together.</li>
          <li><strong>Fetch and verify.</strong> Clone the build repository, download the corpus shards and check their SHA-256 digests against the repository&rsquo;s lock.</li>
          <li><strong>Preserve the splits.</strong> The indexes keep entire scores in one split. Keep that separation when sampling crops or comparing checkpoints.</li>
          <li><strong>Rebuild when needed.</strong> Each repository documents its source inputs, pinned converter and rendering environment. OSSQ and Lieder use scanned material; PDMX uses Verovio 6.2.1 engravings.</li>
        </ol>
        <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100"><code>{`git clone https://github.com/OurTextScores/ossq-omr-data.git
cd ossq-omr-data
make fetch-corpus
make verify-corpus

# To fetch only the validation split:
make fetch-corpus SPLIT=valid`}</code></pre>
        <p>
          The same fetch commands are available in the Lieder and PDMX build
          repositories. PDMX&rsquo;s default lock fetches v1; the expanded v2
          release has its own manifest and build recipe above.
        </p>
        <p>
          The dataset cards and source manifests record attribution and rights.
          Build-code licences and source-image licences are separate; the Lieder
          source ledger records individual IMSLP files, while PDMX records the
          selected scores&rsquo; public-domain and CC0 provenance.
        </p>
      </Section>

      <Section id="scanner-recipe" title="The OTS-HOMR scanner recipe">
        <p>
          OTS-HOMR v11 combines a scan-adapted HOMR recognition core, structured
          notation heads, and a separate lyric, direction and dynamics review
          pipeline. Its minimal source recipe records the runtime, dependencies,
          calibration and exact model identities used for inference.
        </p>
        <p>
          <ExternalLink href="https://github.com/OurTextScores/homr/tree/release/v11-minimal">Minimal HOMR repository</ExternalLink>{" "}
          · <ExternalLink href={`${recipeRoot}/release/V11_RECIPE.md`}>v11 recipe</ExternalLink>{" "}
          · <ExternalLink href={`${recipeRoot}/release/v11-source-manifest.json`}>Source manifest</ExternalLink>{" "}
          · <ExternalLink href={`${recipeRoot}/services/ots-homr-modal/pins.py`}>Model revisions and checksums</ExternalLink>
        </p>
        <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100"><code>{`git clone --branch release/v11-minimal https://github.com/OurTextScores/homr.git
cd homr
python release/verify_source.py
python release/build_source.py`}</code></pre>
        <p>
          This recipe reproduces the scanner source and its pinned-weight
          inference setup. Rebuilding a training corpus is a separate step from
          retraining the historical v11 weights. The OurTextScores application
          provides the scanner queue, review interface and score export; its
          integration is described in the recipe.
        </p>
        <p>
          <ExternalLink href="https://github.com/OurTextScores/OurTextScores">OurTextScores application source</ExternalLink>{" "}
          · <Link href="/ots-homr/benchmark" className={link}>Recognition benchmark</Link>{" "}
          · <Link href="/ots-homr/benchmark/method" className={link}>Evaluation method</Link>
        </p>
      </Section>
    </main>
  );
}
