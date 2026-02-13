import Link from "next/link";
import { redirect } from "next/navigation";
import { getApiAuthHeaders } from "../../lib/authToken";
import { fetchBackendSession } from "../../lib/server-session";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

interface DmcaCase {
  caseId: string;
  status: string;
  submittedAt: string;
  reviewedAt?: string;
  target: {
    workId: string;
    sourceId: string;
    revisionId?: string;
    scope: "source" | "revision";
  };
  complainant?: {
    name?: string;
    email?: string;
  };
  uploaderUserId?: string;
}

interface DmcaMetrics {
  window: { from: string; to: string; days: number };
  noticesReceived: number;
  counterNoticesReceived: number;
  disabledCases: number;
  restoredCases: number;
  reinstatementRatio: number | null;
  medianTimeToDisableHours: number | null;
  medianCounterNoticeTurnaroundHours: number | null;
  casesByStatus: Record<string, number>;
}

async function fetchDmcaCases(): Promise<DmcaCase[]> {
  const api = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const res = await fetch(`${api}/legal/dmca/cases?limit=100&offset=0`, {
    headers: {
      "Content-Type": "application/json",
      ...(auth.Authorization && { Authorization: auth.Authorization })
    },
    cache: "no-store"
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchDmcaMetrics(): Promise<DmcaMetrics | null> {
  const api = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const res = await fetch(`${api}/legal/dmca/metrics?days=90`, {
    headers: {
      "Content-Type": "application/json",
      ...(auth.Authorization && { Authorization: auth.Authorization })
    },
    cache: "no-store"
  });
  if (!res.ok) return null;
  return res.json();
}

function formatHours(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  return `${value.toFixed(2)}h`;
}

function formatRatio(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}

export default async function DmcaCasesPage() {
  const session = await fetchBackendSession();
  if (!session?.user?.roles?.includes("admin")) {
    redirect("/");
  }

  const [cases, metrics] = await Promise.all([fetchDmcaCases(), fetchDmcaMetrics()]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 py-8 px-4">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="mb-2 flex items-center justify-between">
          <Link
            href="/"
            className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            ← Back to Home
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/admin/flagged-comments"
              className="text-sm text-cyan-700 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100"
            >
              Flagged Comments
            </Link>
            <Link
              href="/admin/flagged-sources"
              className="text-sm text-cyan-700 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100"
            >
              Flagged Sources
            </Link>
          </div>
        </div>

        <section className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 mb-2">
            DMCA Cases Dashboard
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Case workflow metrics and recent notices.
          </p>
        </section>

        <section className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4">
            90-Day Metrics
          </h2>
          {metrics ? (
            <>
              <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Window: {new Date(metrics.window.from).toLocaleDateString()} -{" "}
                {new Date(metrics.window.to).toLocaleDateString()} ({metrics.window.days} days)
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Notices Received</div>
                  <div className="text-xl font-semibold">{metrics.noticesReceived}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Counter Notices</div>
                  <div className="text-xl font-semibold">{metrics.counterNoticesReceived}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Median Disable Time</div>
                  <div className="text-xl font-semibold">{formatHours(metrics.medianTimeToDisableHours)}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Median Counter-Notice Turnaround</div>
                  <div className="text-xl font-semibold">{formatHours(metrics.medianCounterNoticeTurnaroundHours)}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Disabled Cases</div>
                  <div className="text-xl font-semibold">{metrics.disabledCases}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Restored Cases</div>
                  <div className="text-xl font-semibold">{metrics.restoredCases}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Reinstatement Ratio</div>
                  <div className="text-xl font-semibold">{formatRatio(metrics.reinstatementRatio)}</div>
                </div>
                <div className="rounded border border-slate-200 dark:border-slate-700 p-3">
                  <div className="text-xs text-slate-500 dark:text-slate-400">Cases by Status</div>
                  <div className="text-xs mt-2 space-y-1">
                    {Object.entries(metrics.casesByStatus).length === 0 ? (
                      <div className="text-slate-500 dark:text-slate-400">No cases in window</div>
                    ) : (
                      Object.entries(metrics.casesByStatus).map(([status, count]) => (
                        <div key={status} className="flex items-center justify-between">
                          <span>{status}</span>
                          <span className="font-semibold">{count}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500 dark:text-slate-400">
              Unable to load metrics.
            </div>
          )}
        </section>

        <section className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Recent Cases
          </h2>
          {cases.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400">No DMCA cases yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
                <thead className="bg-slate-50 dark:bg-slate-900">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Case
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Target
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Complainant
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      Submitted
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-800">
                  {cases.map((c) => (
                    <tr key={c.caseId} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                      <td className="px-4 py-3 text-sm text-slate-900 dark:text-slate-100 font-mono">
                        {c.caseId}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                        <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                          {c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                        <Link
                          href={`/works/${encodeURIComponent(c.target.workId)}`}
                          className="font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
                        >
                          {c.target.workId}
                        </Link>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {c.target.sourceId}
                          {c.target.revisionId ? ` / ${c.target.revisionId}` : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                        {c.complainant?.name || "Unknown"}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
                        {new Date(c.submittedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
