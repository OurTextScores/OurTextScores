import Link from "next/link";
import { redirect } from "next/navigation";
import { getApiBase } from "../lib/api";
import { getApiAuthHeaders } from "../lib/authToken";
import { fetchBackendSession } from "../lib/server-session";
import PdmxClient from "./pdmx-client";

const DEFAULT_PDMX_PROJECT_ID = "prj_6282588aac";

async function fetchPdmxRecords(query: {
  q: string;
  group: string;
  sort: string;
  limit: number;
  offset: number;
  includeUnacceptable: boolean;
  hideImported: boolean;
  requireNoLicenseConflict: boolean;
  subset: string;
  importStatus: string;
  hasPdf: string;
}) {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.group) params.set("group", query.group);
  if (query.sort) params.set("sort", query.sort);
  params.set("limit", String(query.limit));
  params.set("offset", String(query.offset));
  if (query.includeUnacceptable) params.set("excludeUnacceptable", "false");
  if (!query.requireNoLicenseConflict) params.set("requireNoLicenseConflict", "false");
  if (query.hideImported) params.set("hideImported", "true");
  if (query.subset) params.set("subset", query.subset);
  if (query.importStatus) params.set("importStatus", query.importStatus);
  if (query.hasPdf === "true" || query.hasPdf === "false") params.set("hasPdf", query.hasPdf);

  const res = await fetch(`${API_BASE}/pdmx/records?${params.toString()}`, {
    headers,
    cache: "no-store"
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Failed to fetch PDMX records");
  }
  return res.json();
}

async function fetchProjectOptions(): Promise<Array<{ projectId: string; title: string }>> {
  const API_BASE = getApiBase();
  const headers = await getApiAuthHeaders();
  const res = await fetch(`${API_BASE}/projects?limit=100&offset=0&status=active`, {
    headers,
    cache: "no-store"
  });
  if (!res.ok) {
    return [{ projectId: DEFAULT_PDMX_PROJECT_ID, title: "PDMX (default)" }];
  }
  const data = await res.json();
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  const normalized = projects
    .map((project: any) => ({
      projectId: String(project?.projectId || "").trim(),
      title: String(project?.title || "").trim()
    }))
    .filter((project: { projectId: string }) => project.projectId.length > 0);

  if (!normalized.some((project: { projectId: string }) => project.projectId === DEFAULT_PDMX_PROJECT_ID)) {
    normalized.unshift({ projectId: DEFAULT_PDMX_PROJECT_ID, title: "PDMX (default)" });
  }
  return normalized;
}

export default async function PdmxPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await fetchBackendSession();
  const roles = Array.isArray(session?.user?.roles) ? session.user.roles : [];
  if (!roles.includes("admin")) {
    redirect("/");
  }

  const q = typeof searchParams?.q === "string" ? searchParams.q : "";
  const group = typeof searchParams?.group === "string" ? searchParams.group : "";
  const sort = typeof searchParams?.sort === "string" && searchParams.sort
    ? searchParams.sort
    : "updated_desc";
  const limitRaw = Number(typeof searchParams?.limit === "string" ? searchParams.limit : "50");
  const offsetRaw = Number(typeof searchParams?.offset === "string" ? searchParams.offset : "0");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
  const includeUnacceptable = searchParams?.includeUnacceptable === "true";
  const hideImported = searchParams?.hideImported === "true";
  const requireNoLicenseConflict = searchParams?.requireNoLicenseConflict === "false" ? false : true;
  const subset = typeof searchParams?.subset === "string" ? searchParams.subset : "";
  const importStatus = typeof searchParams?.importStatus === "string" ? searchParams.importStatus : "";
  const hasPdf = typeof searchParams?.hasPdf === "string" ? searchParams.hasPdf : "true";

  const data = await fetchPdmxRecords({
    q,
    group,
    sort,
    limit,
    offset,
    includeUnacceptable,
    hideImported,
    requireNoLicenseConflict,
    subset,
    importStatus,
    hasPdf
  }).catch(() => ({ items: [], total: 0, limit, offset }));
  const projectOptions = await fetchProjectOptions();

  return (
    <main className="min-h-screen bg-slate-50 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          <Link href="/" className="text-cyan-700 hover:underline dark:text-cyan-300">
            Home
          </Link>
          <span className="mx-2">/</span>
          <span>PDMX</span>
        </div>

        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">PDMX Records</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Admin-only browser for PDMX rows. Records remain separate from the main catalogue until explicitly imported.
          </p>
        </section>

        <PdmxClient
          initialItems={Array.isArray(data?.items) ? data.items : []}
          projectOptions={projectOptions}
          defaultProjectId={DEFAULT_PDMX_PROJECT_ID}
          total={typeof data?.total === "number" ? data.total : 0}
          limit={typeof data?.limit === "number" ? data.limit : limit}
          offset={typeof data?.offset === "number" ? data.offset : offset}
          initialQuery={{
            q,
            group,
            sort,
            includeUnacceptable,
            hideImported,
            requireNoLicenseConflict,
            subset,
            importStatus,
            hasPdf
          }}
        />
      </div>
    </main>
  );
}
