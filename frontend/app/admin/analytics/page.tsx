import { getApiAuthHeaders } from "../../lib/authToken";

const DEFAULT_TIMEZONE = "America/New_York";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

interface OverviewResponse {
  from: string;
  to: string;
  metrics: {
    wae: number;
    wacu: number;
    weu: number;
    newSignups: number;
    uploadsSuccess: number;
    revisionsSaved: number;
    commentsCreated: number;
    ratingsCreated: number;
    downloadsTotal: number;
    downloadsByFormat: Record<string, number>;
  };
}

interface TimeseriesPoint {
  bucketStart: string;
  bucketLabel: string;
  wae: number;
  wacu: number;
  weu: number;
  newSignups: number;
  uploadsSuccess: number;
  revisionsSaved: number;
  searches: number;
  views: number;
  comments: number;
  ratings: number;
  downloads: number;
}

interface TimeseriesResponse {
  from: string;
  to: string;
  timezone: string;
  bucket: "day" | "week";
  points: TimeseriesPoint[];
}

interface FunnelStep {
  key: "signup_completed" | "first_score_loaded" | "first_revision_saved" | "returned_next_week";
  count: number;
  conversionFromPrevious: number | null;
}

interface FunnelResponse {
  from: string;
  to: string;
  steps: FunnelStep[];
}

interface RetentionCohort {
  cohortStart: string;
  activatedUsers: number;
  retained: {
    w1: number;
    w4: number;
    w8: number;
  };
  retentionRate: {
    w1: number;
    w4: number;
    w8: number;
  };
}

interface RetentionResponse {
  from: string;
  to: string;
  cohorts: RetentionCohort[];
}

interface CatalogResponse {
  from: string;
  to: string;
  totals: {
    works: number;
    sources: number;
    revisions: number;
  };
  newInRange: {
    works: number;
    sources: number;
    revisions: number;
  };
}

function parseInputDate(value?: string, fallback?: Date): Date {
  if (!value) return fallback ?? new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback ?? new Date();
  }
  return parsed;
}

function toDateInputValue(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPercent(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

async function fetchAdminMetric<T>(path: string): Promise<T | null> {
  try {
    const api = getBackendApiBase();
    const auth = await getApiAuthHeaders();
    const res = await fetch(`${api}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(auth.Authorization ? { Authorization: auth.Authorization } : {})
      },
      cache: "no-store"
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default async function AdminAnalyticsPage({
  searchParams
}: {
  searchParams?: { from?: string; to?: string };
}) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  const fromDate = parseInputDate(searchParams?.from, defaultFrom);
  const toDate = parseInputDate(searchParams?.to, now);

  const fromIso = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), 0, 0, 0)).toISOString();
  const toIso = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate(), 23, 59, 59)).toISOString();

  const commonQuery = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&excludeAdmins=true`;

  const [overview, timeseries, funnel, retention, catalog] = await Promise.all([
    fetchAdminMetric<OverviewResponse>(`/analytics/metrics/overview?${commonQuery}`),
    fetchAdminMetric<TimeseriesResponse>(
      `/analytics/metrics/timeseries?${commonQuery}&timezone=${encodeURIComponent(DEFAULT_TIMEZONE)}&bucket=day`
    ),
    fetchAdminMetric<FunnelResponse>(`/analytics/metrics/funnel?${commonQuery}`),
    fetchAdminMetric<RetentionResponse>(
      `/analytics/metrics/retention?${commonQuery}&timezone=${encodeURIComponent(DEFAULT_TIMEZONE)}`
    ),
    fetchAdminMetric<CatalogResponse>(`/analytics/metrics/catalog?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
  ]);

  const weuMax = Math.max(...(timeseries?.points ?? []).map((point) => point.weu), 1);

  return (
    <>
      <section className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
          <h1 className="mb-2 text-3xl font-bold text-slate-900 dark:text-slate-100">Analytics Dashboard</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">Growth, engagement, retention, and catalog metrics (admins excluded by default).</p>

          <form className="mt-4 flex flex-wrap items-end gap-3" method="GET">
            <label className="text-xs text-slate-600 dark:text-slate-400">
              From
              <input
                type="date"
                name="from"
                defaultValue={toDateInputValue(fromDate)}
                className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <label className="text-xs text-slate-600 dark:text-slate-400">
              To
              <input
                type="date"
                name="to"
                defaultValue={toDateInputValue(toDate)}
                className="mt-1 block rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <button
              type="submit"
              className="rounded bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600"
            >
              Apply Range
            </button>
          </form>
      </section>

      <section className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
          <h2 className="mb-4 text-xl font-semibold text-slate-900 dark:text-slate-100">Overview</h2>
          {!overview ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Unable to load overview metrics.</p>
          ) : (
            <>
              <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Window: {new Date(overview.from).toLocaleDateString()} - {new Date(overview.to).toLocaleDateString()}
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">WAE</div><div className="text-xl font-semibold">{overview.metrics.wae}</div></div>
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">WACU</div><div className="text-xl font-semibold">{overview.metrics.wacu}</div></div>
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">WEU</div><div className="text-xl font-semibold">{overview.metrics.weu}</div></div>
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">New Signups</div><div className="text-xl font-semibold">{overview.metrics.newSignups}</div></div>
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">Downloads</div><div className="text-xl font-semibold">{overview.metrics.downloadsTotal}</div></div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200">Activity</div>
                  <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                    Uploads: <span className="font-semibold">{overview.metrics.uploadsSuccess}</span> · Revisions Saved: <span className="font-semibold">{overview.metrics.revisionsSaved}</span> · Comments: <span className="font-semibold">{overview.metrics.commentsCreated}</span> · Ratings: <span className="font-semibold">{overview.metrics.ratingsCreated}</span>
                  </div>
                </div>
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200">Downloads by Format</div>
                  <div className="mt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                    {Object.entries(overview.metrics.downloadsByFormat).length === 0 ? (
                      <div>No downloads in range.</div>
                    ) : (
                      Object.entries(overview.metrics.downloadsByFormat).map(([format, count]) => (
                        <div key={format} className="flex items-center justify-between">
                          <span>{format}</span>
                          <span className="font-semibold">{count}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <section className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
          <h2 className="mb-4 text-xl font-semibold text-slate-900 dark:text-slate-100">Timeseries (Daily)</h2>
          {!timeseries ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Unable to load timeseries.</p>
          ) : timeseries.points.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No timeseries points in this window.</p>
          ) : (
            <div className="space-y-2">
              {timeseries.points.map((point) => {
                const widthPct = Math.max((point.weu / weuMax) * 100, point.weu > 0 ? 3 : 0);
                return (
                  <div key={point.bucketStart} className="grid grid-cols-[96px_1fr_120px] items-center gap-3 text-xs">
                    <div className="text-slate-500 dark:text-slate-400">{point.bucketLabel}</div>
                    <div className="h-3 rounded bg-slate-200 dark:bg-slate-700">
                      <div className="h-3 rounded bg-cyan-600" style={{ width: `${widthPct}%` }} />
                    </div>
                    <div className="text-right text-slate-700 dark:text-slate-200">WEU {point.weu} · WAE {point.wae} · WACU {point.wacu}</div>
                  </div>
                );
              })}
            </div>
          )}
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
            <h2 className="mb-4 text-xl font-semibold text-slate-900 dark:text-slate-100">Funnel</h2>
            {!funnel ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">Unable to load funnel metrics.</p>
            ) : (
              <div className="space-y-2 text-sm">
                {funnel.steps.map((step) => (
                  <div key={step.key} className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 dark:border-slate-700">
                    <span className="text-slate-700 dark:text-slate-200">{step.key}</span>
                    <span className="text-slate-700 dark:text-slate-200">
                      <span className="font-semibold">{step.count}</span>
                      {step.conversionFromPrevious !== null && (
                        <span className="ml-2 text-xs text-slate-500">({formatPercent(step.conversionFromPrevious)})</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
            <h2 className="mb-4 text-xl font-semibold text-slate-900 dark:text-slate-100">Catalog</h2>
            {!catalog ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">Unable to load catalog metrics.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 text-sm">
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
                  <div className="text-xs text-slate-500">Totals</div>
                  <div className="mt-1">Works: <span className="font-semibold">{catalog.totals.works}</span> · Sources: <span className="font-semibold">{catalog.totals.sources}</span> · Revisions: <span className="font-semibold">{catalog.totals.revisions}</span></div>
                </div>
                <div className="rounded border border-slate-200 p-3 dark:border-slate-700">
                  <div className="text-xs text-slate-500">Added in Range</div>
                  <div className="mt-1">Works: <span className="font-semibold">{catalog.newInRange.works}</span> · Sources: <span className="font-semibold">{catalog.newInRange.sources}</span> · Revisions: <span className="font-semibold">{catalog.newInRange.revisions}</span></div>
                </div>
              </div>
            )}
          </div>
      </section>

      <section className="rounded-lg bg-white p-6 shadow-lg dark:bg-slate-800">
          <h2 className="mb-4 text-xl font-semibold text-slate-900 dark:text-slate-100">Retention Cohorts</h2>
          {!retention ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Unable to load retention metrics.</p>
          ) : retention.cohorts.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No activation cohorts in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
                <thead className="bg-slate-50 dark:bg-slate-900">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs uppercase text-slate-500">Cohort</th>
                    <th className="px-4 py-2 text-left text-xs uppercase text-slate-500">Activated</th>
                    <th className="px-4 py-2 text-left text-xs uppercase text-slate-500">W1</th>
                    <th className="px-4 py-2 text-left text-xs uppercase text-slate-500">W4</th>
                    <th className="px-4 py-2 text-left text-xs uppercase text-slate-500">W8</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {retention.cohorts.map((cohort) => (
                    <tr key={cohort.cohortStart}>
                      <td className="px-4 py-2 text-sm">{new Date(cohort.cohortStart).toLocaleDateString()}</td>
                      <td className="px-4 py-2 text-sm">{cohort.activatedUsers}</td>
                      <td className="px-4 py-2 text-sm">{cohort.retained.w1} ({formatPercent(cohort.retentionRate.w1)})</td>
                      <td className="px-4 py-2 text-sm">{cohort.retained.w4} ({formatPercent(cohort.retentionRate.w4)})</td>
                      <td className="px-4 py-2 text-sm">{cohort.retained.w8} ({formatPercent(cohort.retentionRate.w8)})</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </>
  );
}
