# Public core versus upstream — frozen 2026-09-28

Direct recognition comparison, independent of the running structured-head loss trial.
Models: pinned upstream HOMR checkpoint 426 / current locally pinned OTS core
(2026-09-18 SHA 1b2855ce...) / public-rareNum-20260927 (SHA 89a97a20...). All three
use the same current PyTorch architecture and greedy decoder implementation, one CPU
thread, FP32 CUDA, no added heads, reranking, post-decode repair or training augmentation.
Each uses its native vocabulary; strict state loading forbids growing random rows or
silently leaving parameters uninitialized. Upstream vocabulary is archived from commit
b6fd20809a8dcaf10dfd39a4ca4f64c6f056e644 and verified against checkpoint dimensions.
This compares the pinned upstream model through a common inference path, not every
version of upstream HOMR or its entire page pipeline.

All three use identical grayscale staff crops, canvas preparation and normalization.
Record each crop SHA-256, unchanged raw six-branch reference arrays, raw predictions,
failures, sequence-limit hits and per-staff time. Failures count as empty predictions,
not exclusion. Data: fixed OSSQ 792-staff benchmark, all PDMX 3,422 validation staves,
all Lieder v8 300 validation staves. No test split is read; these validation sets have
been inspected in previous investigations. No model selection or retraining here.

Primary quality metric: aligned whole-symbol edit error rate on the common vocabulary,
each symbol represented by its six attributes. Remove timeSignatureBeats_ symbols from
reference and prediction before this comparison. Report full-vocabulary error rate
separately; explicit numerator recognition is an added capability, not a fair common-
vocabulary training gain. Upstream's seven-class accidental vocabulary already has N;
the historical claim that 426 lacks natural signs must not be reused.

Also report aligned edit errors per branch, pitch+accidental note-sequence errors,
exact staff percentage, historical positional accuracy, failed staff counts, sequence
limit hits, and exact-position 5/x and 12/x detections. None are whole-page MusicXML
correctness or notation-head quality. Report each source separately.

Use paired bootstrap 2,000 replicates, seed 20260928, resampling complete score groups
within each source, not independent overlapping windows/voices. Compare public against
upstream and pinned against upstream, plus public against pinned. Confidence intervals
must support an improvement claim; report neutral or worse results equally. Report
reference/support counts and unique score counts. Check identical IDs, references and
image hashes across all three models. Retain all predictions for audit/examples.

Four disjoint row shards preserve all source row identities. Model vocabularies are
applied before architecture construction; upstream width 260, newer rhythm width 279.
Parallel workers share the GPU with the existing head trial only if smoke memory and
throughput are acceptable. Timing under concurrent jobs is descriptive and does not
support production-latency claims. Persistent tmux workers and watcher, resumable
JSONL output, automatic local archive/checksum verification on completion.

The reproducible candidate retains its documented replay deviation: 572 PDMX rows,
226 planned GrandStaff replay rows unavailable. It is a published-input rebuild,
not an exact reconstruction of the historical training run.

After results are verified, update homr/docs/PIPELINE.md first, prepare an evidence-backed
local update for OurTextScores/frontend/app/ots-homr/page.tsx, and retain the distinction
between candidate and deployed model. No deployment or push is included.
