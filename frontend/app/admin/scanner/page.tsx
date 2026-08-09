import { getApiAuthHeaders } from "../../lib/authToken";
import { getBackendApiBase } from "../../api/proxy/_lib/upstream";

export const dynamic = "force-dynamic";

type Metrics = {
  windowHours: number;
  generatedAt: string;
  jobs: Record<string, number>;
  pagesByStatus: { succeeded: number; failed: number };
  queue: { depth: number; oldestQueuedAgeMs: number | null };
  pageLatencyMs: {
    samples: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  failureRate: number;
  failuresByCode: Record<string, number>;
  renderSuccessRate: number | null;
  provider: { calls: number; approximateSeconds: number };
  alerts: Array<{ key: string; message: string }>;
};

async function loadMetrics(): Promise<
  { ok: true; data: Metrics } | { ok: false; reason: string }
> {
  try {
    const auth = await getApiAuthHeaders();
    const response = await fetch(
      `${getBackendApiBase()}/scanner/jobs/metrics?windowHours=24`,
      { headers: auth as Record<string, string>, cache: "no-store" },
    );
    if (!response.ok) {
      return {
        ok: false,
        reason:
          response.status === 503
            ? "Scanner is not enabled on this deployment."
            : `The metrics endpoint returned HTTP ${response.status}.`,
      };
    }
    return { ok: true, data: (await response.json()) as Metrics };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      {hint && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
    </div>
  );
}

export default async function AdminScannerPage() {
  const result = await loadMetrics();

  if (!result.ok) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Scanner
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {result.reason}
        </p>
      </div>
    );
  }

  const m = result.data;
  const jobEntries = Object.entries(m.jobs).sort((a, b) => b[1] - a[1]);
  const failures = Object.entries(m.failuresByCode).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          Scanner
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Last {m.windowHours} hours · generated{" "}
          {new Date(m.generatedAt).toLocaleString()}. Operational aggregates
          only — no filenames, scores, or artifact locations.
        </p>
      </div>

      {/* Conditions worth acting on come first, so this page is useful at a
          glance rather than needing to be read. */}
      {m.alerts.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Needs attention
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
            {m.alerts.map((alert) => (
              <li key={alert.key}>{alert.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          No alert conditions are currently firing.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Queue depth"
          value={String(m.queue.depth)}
          hint={`oldest waiting ${duration(m.queue.oldestQueuedAgeMs)}`}
        />
        <Stat
          label="Pages succeeded"
          value={String(m.pagesByStatus.succeeded)}
          hint={`${m.pagesByStatus.failed} failed`}
        />
        <Stat
          label="Failure rate"
          value={`${(m.failureRate * 100).toFixed(1)}%`}
          hint={
            m.renderSuccessRate === null
              ? "no successful pages yet"
              : `${(m.renderSuccessRate * 100).toFixed(0)}% rendered a PDF`
          }
        />
        <Stat
          label="Provider time"
          value={`${m.provider.approximateSeconds}s`}
          hint={`${m.provider.calls} calls — upper bound, not a bill`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Page recognition latency
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Wall clock per page, so a cold provider inflates it. The §11.4 gate
            is warm p95 under 60 s.
          </p>
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            {[
              ["p50", m.pageLatencyMs.p50],
              ["p95", m.pageLatencyMs.p95],
              ["max", m.pageLatencyMs.max],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-xs text-slate-500 dark:text-slate-400">
                  {label as string}
                </dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100">
                  {duration(value as number | null)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {m.pageLatencyMs.samples} sample
            {m.pageLatencyMs.samples === 1 ? "" : "s"}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Jobs by status
          </h2>
          {jobEntries.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No jobs in this window.
            </p>
          ) : (
            <ul className="mt-3 space-y-1 text-sm">
              {jobEntries.map(([status, count]) => (
                <li
                  key={status}
                  className="flex justify-between text-slate-700 dark:text-slate-300"
                >
                  <span>{status}</span>
                  <span className="font-medium tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {failures.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Failures by cause
          </h2>
          <ul className="mt-3 space-y-1 text-sm">
            {failures.map(([code, count]) => (
              <li
                key={code}
                className="flex justify-between text-slate-700 dark:text-slate-300"
              >
                <span className="font-mono text-xs">{code}</span>
                <span className="font-medium tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
