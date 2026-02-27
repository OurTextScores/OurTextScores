import Link from "next/link";
import { getApiAuthHeaders } from "../../lib/authToken";

function getBackendApiBase(): string {
  const raw = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:4000/api";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

interface FlaggedSource {
  workId: string;
  sourceId: string;
  label: string;
  sourceType: string;
  originalFilename: string;
  latestRevisionId?: string;
  latestRevisionAt?: string;
  visibility?: "public" | "withheld_dmca" | "under_review";
  adminFlagReason?: string;
  adminFlaggedAt?: string;
  uploadedByUserId?: string;
  uploadedByUsername?: string;
  adminFlaggedBy?: string;
  adminFlaggedByUsername?: string;
}

async function fetchFlaggedSources(): Promise<FlaggedSource[]> {
  const api = getBackendApiBase();
  const auth = await getApiAuthHeaders();
  const res = await fetch(`${api}/works/admin/flagged-sources`, {
    headers: {
      "Content-Type": "application/json",
      ...(auth.Authorization && { Authorization: auth.Authorization })
    },
    cache: "no-store"
  });
  if (!res.ok) return [];
  return res.json();
}

export default async function FlaggedSourcesPage() {
  const sources = await fetchFlaggedSources();

  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6">
      <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 mb-2">
        Flagged Sources Dashboard
      </h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
        Total flagged sources: <strong>{sources.length}</strong>
      </p>

      {sources.length === 0 ? (
        <div className="text-center py-12 text-slate-500 dark:text-slate-400">
          No flagged sources at this time.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
            <thead className="bg-slate-50 dark:bg-slate-900">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Work / Source
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Uploaded By
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Flagged By
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Reason
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Visibility
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Flagged At
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-800">
              {sources.map((s) => (
                <tr key={`${s.workId}:${s.sourceId}`} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                  <td className="px-4 py-3 text-sm text-slate-900 dark:text-slate-100">
                    <Link
                      href={`/works/${encodeURIComponent(s.workId)}`}
                      className="font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
                    >
                      {s.workId}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {s.label} ({s.sourceId.slice(0, 8)}...)
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                    {s.uploadedByUsername || s.uploadedByUserId || "Unknown"}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                    {s.adminFlaggedByUsername || s.adminFlaggedBy || "Unknown"}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
                    {s.adminFlagReason || "No reason provided"}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                      {s.visibility || "public"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
                    {s.adminFlaggedAt ? new Date(s.adminFlaggedAt).toLocaleString() : "N/A"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
