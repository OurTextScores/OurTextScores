import { createHash } from 'node:crypto';
import type { ScannerPageResult, ScannerStorageLocator } from './schemas/scanner-job.schema';

export const REVIEW_STEPS = ['base', 'heads', 'engines'] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];
export type ReviewSnapshot = Pick<
  ScannerPageResult,
  | 'engines'
  | 'musicXml'
  | 'reviewedMusicXml'
  | 'review'
  | 'corrections'
  | 'mergedMusicXml'
  | 'mergedScore'
> & {
  checkpointStorage?: ScannerStorageLocator;
  checkpointSignature?: string;
  checkpointMergeRevision?: number;
  retainedArtifacts?: ScannerStorageLocator[];
};
export interface ReviewCheckpoint {
  snapshot: ReviewSnapshot;
  inputSignature: string;
  completedSignature?: string;
  skipped?: boolean;
  savedAt: string;
  previous?: ReviewSnapshot;
  original?: ReviewSnapshot;
  positions?: Record<string, { position: number; contentSignature: string }>;
}
export interface ScannerReviewWorkflow {
  active: ReviewStep;
  revision: number;
  mergeRevision: number;
  stateVersion: number;
  steps: Partial<Record<ReviewStep, ReviewCheckpoint>>;
}

export function reviewSnapshot(page: ReviewSnapshot): ReviewSnapshot {
  if (page.checkpointStorage) throw new Error('Load the saved review checkpoint before editing it');
  const { engines, musicXml, reviewedMusicXml, review, corrections, mergedMusicXml, mergedScore } =
    page;
  return structuredClone({
    engines,
    musicXml,
    reviewedMusicXml,
    review,
    corrections,
    mergedMusicXml,
    mergedScore
  });
}

// Ignore derivative generation and merge revision counters: only musical input
// and review choices make a downstream checkpoint stale.
export function reviewSignature(snapshot: ReviewSnapshot): string {
  if (snapshot.checkpointStorage) return snapshot.checkpointSignature!;
  return createHash('sha256')
    .update(
      JSON.stringify({
        engines: Object.entries(snapshot.engines || {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, run]) => [
            id,
            {
              xml: run?.reviewedMusicXml?.checksumSha256 || run?.artifacts.musicXml?.checksumSha256,
              proposal: run?.artifacts['structured-heads']?.checksumSha256,
              selected: run?.selectedStructuredHeadFamilies || [],
              review: run?.review,
              corrections: run?.corrections
            }
          ]),
        xml: snapshot.musicXml?.checksumSha256,
        reviewed: snapshot.reviewedMusicXml?.checksumSha256,
        merged: snapshot.mergedMusicXml?.checksumSha256,
        decisions: snapshot.mergedScore?.decisions,
        review: snapshot.review,
        corrections: snapshot.corrections
      })
    )
    .digest('hex');
}

export function workflowState(page: ScannerPageResult) {
  const workflow = page.reviewWorkflow;
  if (!workflow) return undefined;
  const snapshots = { ...workflow.steps };
  const current = snapshots[workflow.active];
  if (current) snapshots[workflow.active] = { ...current, snapshot: page };
  let precedingComplete = true;
  let precedingStale = false;
  return {
    active: workflow.active,
    revision: workflow.revision,
    stateVersion: workflow.stateVersion,
    steps: Object.fromEntries(
      REVIEW_STEPS.map((step, index) => {
        const saved = snapshots[step];
        const previous = snapshots[REVIEW_STEPS[index - 1]];
        const stale =
          index > 0 &&
          Boolean(saved) &&
          (precedingStale ||
            saved?.inputSignature !== (previous ? reviewSignature(previous.snapshot) : undefined));
        precedingStale = stale;
        const available = precedingComplete;
        const complete = Boolean(
          available &&
            saved?.completedSignature &&
            saved.completedSignature === reviewSignature(saved.snapshot) &&
            !stale
        );
        precedingComplete = complete;
        return [
          step,
          {
            hasPreviousResult: Boolean(saved?.previous || (stale && saved)),
            positions: saved?.positions || {},
            saved: Boolean(saved),
            complete,
            skipped: Boolean(complete && saved?.skipped),
            stale,
            savedAt: saved?.savedAt,
            available
          }
        ];
      })
    )
  };
}

/** Checkpoint artifacts must survive ordinary superseded-artifact cleanup. */
export function snapshotArtifactLocators(snapshot: unknown): ScannerStorageLocator[] {
  const result: ScannerStorageLocator[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.bucket === 'string' && typeof object.objectKey === 'string') {
      result.push(value as ScannerStorageLocator);
      return;
    }
    Object.values(object).forEach(visit);
  };
  visit(snapshot);
  return result;
}

export function workflowArtifactLocators(page: ScannerPageResult): ScannerStorageLocator[] {
  return snapshotArtifactLocators(page.reviewWorkflow?.steps);
}

export function workflowRetains(page: ScannerPageResult, locator: ScannerStorageLocator): boolean {
  return workflowArtifactLocators(page).some(
    (item) => item.bucket === locator.bucket && item.objectKey === locator.objectKey
  );
}

export function startReviewWorkflow(page: ScannerPageResult): ScannerPageResult {
  const baseline = reviewSnapshot(page);
  baseline.mergedMusicXml = undefined;
  baseline.mergedScore = undefined;
  const run = baseline.engines?.['ots-homr'];
  if (run) {
    run.artifacts.musicXml =
      run.artifacts['structured-comparison-base-musicxml'] ||
      run.outputCandidates?.core?.musicXml ||
      run.artifacts.musicXml;
    run.selectedStructuredHeadFamilies = [];
    run.structuredOutputError = undefined;
  }
  const now = new Date().toISOString();
  const workflow: ScannerReviewWorkflow = {
    active: 'base',
    revision: 1,
    stateVersion: 1,
    mergeRevision: (page.mergedScore?.revision || 0) + 1,
    steps: {
      base: {
        snapshot: baseline,
        original: reviewSnapshot(baseline),
        inputSignature: 'original',
        savedAt: now
      }
    }
  };
  if (page.mergedMusicXml) {
    const step = page.mergedScore?.sourceEngineId.startsWith('ots-homr-') ? 'heads' : 'engines';
    workflow.steps[step] = {
      snapshot: reviewSnapshot(page),
      inputSignature: 'legacy',
      savedAt: now
    };
  }
  return { ...page, ...baseline, reviewWorkflow: workflow, pdf: undefined };
}

/** Build a stage's input from its predecessor's accepted output. */
export function nextReviewInput(step: ReviewStep, previous: ReviewSnapshot): ReviewSnapshot {
  const input = reviewSnapshot(previous);
  if (step === 'engines' && previous.mergedMusicXml) {
    const run = input.engines?.['ots-homr'];
    if (run) run.reviewedMusicXml = previous.mergedMusicXml;
  }
  input.mergedMusicXml = undefined;
  input.mergedScore = undefined;
  return input;
}

/** A new stage also invalidates editors which have not saved their first merge yet. */
export function reviewMergeRevision(page: ScannerPageResult): number {
  return page.mergedScore?.revision ?? page.reviewWorkflow?.mergeRevision ?? 0;
}

/** Guards page-wide worker writes against a newer workflow or saved cursor. */
export function workflowWriteGuard(pages: ScannerPageResult[]): Record<string, number | null> {
  return Object.fromEntries(
    pages.flatMap((page, index) => [
      [`pages.${index}.reviewWorkflow.stateVersion`, page.reviewWorkflow?.stateVersion ?? null]
    ])
  );
}
