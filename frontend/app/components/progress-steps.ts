export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export interface StepDef { id: string; label: string; variants?: string[]; optional?: boolean }
export interface StepState extends StepDef { status: StepStatus; ms?: number }

export function stepDefs(): StepDef[] {
  return [
    { id: 'upload.received', label: 'Upload received' },
    { id: 'upload.stored', label: 'Stored raw upload' },
    { id: 'pipeline.start', label: 'Start pipeline' },
    { id: 'deriv.input', label: 'Saved working copy', optional: true },
    { id: 'deriv.mscz2mxl', label: 'MuseScore → MXL', variants: ['deriv.mscz2mxl','deriv.canonical','deriv.xml2mxl'] },
    { id: 'deriv.pdf', label: 'Generated PDF', optional: true },
    { id: 'store.normalized', label: 'Stored normalized MXL', optional: true },
    { id: 'store.canonical', label: 'Stored canonical XML' },
    { id: 'deriv.linearized', label: 'Linearized LMX' },
    { id: 'store.linearized', label: 'Stored linearized LMX' },
    { id: 'diff.queued', label: 'Diff queued (async)', optional: true },
    { id: 'store.pdf', label: 'Stored PDF', optional: true },
    { id: 'deriv.manifest', label: 'Stored manifest' },
    { id: 'pipeline.done', label: 'Pipeline done' },
    // Error stage so UI can indicate issues if published
    { id: 'pipeline.error', label: 'Pipeline error', optional: true },
    { id: 'fossil.start', label: 'Fossil commit' },
    { id: 'fossil.done', label: 'Fossil committed', optional: true },
    { id: 'fossil.noid', label: 'Fossil (no id)', optional: true },
    { id: 'fossil.skipped', label: 'Fossil skipped', optional: true },
    { id: 'fossil.failed', label: 'Fossil failed', optional: true },
    { id: 'db.revision', label: 'Record revision' },
    { id: 'db.source', label: 'Update source' },
    { id: 'done', label: 'Finished' }
  ];
}

export function initSteps(): StepState[] {
  return stepDefs().map((d, idx) => ({ ...d, status: idx === 0 ? 'active' : 'pending' }));
}

export function applyEventToSteps(prev: StepState[], stage: string | undefined, startedAtMs: number): StepState[] {
  if (!stage) return prev;
  const now = Date.now();
  const out = prev.map(s => ({ ...s }));
  const findIndexByStage = (s: string): number => out.findIndex(st => st.id === s || (st.variants && st.variants.includes(s)));
  const idx = findIndexByStage(stage);
  let changed = false;

  const mark = (i: number, status: StepStatus) => {
    if (i < 0 || i >= out.length) return;
    if (out[i].status !== status) {
      changed = true;
    }
    out[i].status = status;
    if (!out[i].ms) out[i].ms = now - startedAtMs;
  };

  if (stage.startsWith('fossil.')) {
    const baseIdx = findIndexByStage('fossil.start');
    if (stage === 'fossil.failed') mark(baseIdx, 'failed');
    else if (stage === 'fossil.skipped') mark(baseIdx, 'skipped');
    else mark(baseIdx, 'done');
    mark(idx, stage === 'fossil.failed' ? 'failed' : stage === 'fossil.skipped' ? 'skipped' : 'done');
  } else {
    if (idx !== -1) {
      // Treat pipeline error as a failed step so the UI can highlight it
      if (stage === 'pipeline.error') {
        mark(idx, 'failed');
      } else {
        mark(idx, 'done');
      }
    }
  }

  if (changed) {
    const nextPending = out.findIndex(s => s.status === 'pending');
    if (nextPending !== -1) {
      const currentActive = out.findIndex(s => s.status === 'active');
      if (currentActive === -1 || currentActive > nextPending || out[currentActive].status === 'done') {
         out[nextPending].status = 'active';
      }
    }
  }

  return changed ? out : prev;
}
