# Distributed semantic diff backlog

## Goal

Generate a semantic score diff between a newly accepted revision and its selected parent without adding CPU or memory pressure to the synchronous upload pipeline.

The former in-process `musicdiff` implementation was disabled after causing out-of-memory failures and was removed in commit `4c176d9`. Do not restore that implementation inside `UploadSourceService`.

## Proposed shape

- Publish an idempotent job only after the revision and its canonical MusicXML locator have been persisted.
- Identify work, source, revision, parent revision, branch, and the canonical artifact checksums in the job payload. Treat those identifiers and checksums as the idempotency key.
- Run comparison in a separately deployable worker with explicit memory, CPU, input-size, and execution-time limits.
- Read immutable canonical artifacts from object storage and write versioned semantic-diff artifacts back to auxiliary storage.
- Record `queued`, `running`, `succeeded`, `failed`, and `unsupported` state on the revision. A diff failure must not fail or roll back the accepted revision.
- Retry transient storage or worker failures with a bounded policy; retain terminal failure diagnostics and expose retry to operators.
- Resolve the comparison parent from the committed revision graph, not merely the source's latest revision, so branch and concurrent-upload semantics remain correct.
- Expose availability and failure state through the API before adding download or visual-review UI.

## Acceptance criteria

- Upload latency and upload-worker peak memory do not materially increase when semantic diff is enabled.
- Duplicate delivery cannot produce duplicate artifacts or conflicting revision state.
- Branch revisions compare against their actual parent, including non-linear histories.
- Missing, malformed, oversized, or unsupported MusicXML produces an explicit terminal state rather than a silent omission.
- Worker version, input checksums, output checksum, duration, and resource-limit failures are observable.
- Unit coverage includes job idempotency and parent selection; integration coverage includes success, retry, terminal failure, and an upload that succeeds while diff generation fails.

## Open decision

Evaluate the semantic representation and diff engine separately from the queue architecture. The original Python `musicdiff` output should not be assumed to be the future storage or API contract.
