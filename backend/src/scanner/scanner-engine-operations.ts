import { isScannerEngineId } from './scanner-dual-engine';
import type { ScannerEngineRunStatus } from './scanner-dual-engine';

export interface ScannerEngineOperationalMetrics {
  pagesByStatus: Record<ScannerEngineRunStatus, number>;
  terminalPages: number;
  failureRate: number;
  failuresByCode: Record<string, number>;
  pageLatencyMs: {
    samples: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  renderSuccessRate: number | null;
  provider: {
    calls: number;
    approximateSeconds: number;
  };
}

const RUN_STATUSES: ScannerEngineRunStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped'
];

interface Accumulator {
  pagesByStatus: Record<ScannerEngineRunStatus, number>;
  failuresByCode: Record<string, number>;
  durations: number[];
  rendered: number;
  calls: number;
  providerMs: number;
}

/**
 * Operational-only aggregation over independent engine runs. Legacy page fields
 * are synthesized as HOMR so pre-registry jobs remain visible in the same series.
 */
export function scannerEngineOperationalMetrics(
  jobs: Array<{ enginePlan?: { engineIds?: string[] }; pages?: any[] }>
): Record<string, ScannerEngineOperationalMetrics> {
  const accumulators = new Map<string, Accumulator>();
  for (const job of jobs) {
    for (const page of job.pages || []) {
      for (const [engineId, run] of Object.entries(operationalRuns(job, page))) {
        if (!isScannerEngineId(engineId) || !run || !RUN_STATUSES.includes(run.status)) continue;
        const accumulator = getAccumulator(accumulators, engineId);
        accumulator.pagesByStatus[run.status] += 1;
        accumulator.calls += finiteNumber(run.providerAttempts ?? run.attempts);
        if (Number.isFinite(run.durationMs)) {
          accumulator.providerMs += Number(run.durationMs);
        }
        if (run.status === 'succeeded') {
          if (Number.isFinite(run.durationMs)) accumulator.durations.push(Number(run.durationMs));
          if (run.artifacts?.pdf || (engineId === 'homr' && page.pdf)) {
            accumulator.rendered += 1;
          }
        } else if (run.status === 'failed') {
          const code = String(run.errorCode || 'unknown');
          accumulator.failuresByCode[code] = (accumulator.failuresByCode[code] || 0) + 1;
        }
      }
    }
  }

  return Object.fromEntries(
    [...accumulators.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([engineId, accumulator]) => {
        const succeeded = accumulator.pagesByStatus.succeeded;
        const failed = accumulator.pagesByStatus.failed;
        const terminalPages = succeeded + failed;
        return [
          engineId,
          {
            pagesByStatus: accumulator.pagesByStatus,
            terminalPages,
            failureRate: terminalPages > 0 ? Number((failed / terminalPages).toFixed(4)) : 0,
            failuresByCode: accumulator.failuresByCode,
            pageLatencyMs: {
              samples: accumulator.durations.length,
              p50: percentile(accumulator.durations, 0.5),
              p95: percentile(accumulator.durations, 0.95),
              max: accumulator.durations.length ? Math.max(...accumulator.durations) : null
            },
            renderSuccessRate:
              succeeded > 0 ? Number((accumulator.rendered / succeeded).toFixed(4)) : null,
            provider: {
              calls: accumulator.calls,
              approximateSeconds: Math.round(accumulator.providerMs / 1000)
            }
          }
        ];
      })
  );
}

function operationalRuns(
  job: { enginePlan?: { engineIds?: string[] } },
  page: any
): Record<string, any> {
  const runs = Object.fromEntries(
    Object.entries(page.engines || {}).filter(([, run]) => Boolean(run))
  );
  const planIncludesHomr = !job.enginePlan || job.enginePlan.engineIds?.includes('homr');
  if (!runs.homr && planIncludesHomr) {
    runs.homr = {
      status: page.status,
      attempts: page.attempts,
      providerAttempts: page.providerAttempts,
      durationMs: page.durationMs,
      errorCode: page.errorCode,
      artifacts: { musicXml: page.musicXml, pdf: page.pdf }
    };
  }
  return runs;
}

function getAccumulator(map: Map<string, Accumulator>, engineId: string): Accumulator {
  const existing = map.get(engineId);
  if (existing) return existing;
  const created: Accumulator = {
    pagesByStatus: Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
      ScannerEngineRunStatus,
      number
    >,
    failuresByCode: {},
    durations: [],
    rendered: 0,
    calls: 0,
    providerMs: 0
  };
  map.set(engineId, created);
  return created;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}
