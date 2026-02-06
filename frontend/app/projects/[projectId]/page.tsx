import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchProjectDetail, fetchProjectRows } from "../../lib/api";
import { fetchBackendSession } from "../../lib/server-session";
import ProjectRowsTable from "./project-rows-table";

function fmt(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default async function ProjectDetailPage({
  params
}: {
  params: { projectId: string };
}) {
  const projectId = params.projectId;

  const [project, rowsResult, session] = await Promise.all([
    fetchProjectDetail(projectId).catch(() => notFound()),
    fetchProjectRows(projectId, { limit: 200, offset: 0 }).catch(() => ({ rows: [], total: 0, limit: 200, offset: 0 })),
    fetchBackendSession().catch(() => ({ user: null }))
  ]);

  const user = session.user;
  const roles = user?.roles || [];
  const isAdmin = roles.includes("admin");
  const isLead = !!user?.userId && user.userId === project.lead.userId;
  const isMember = !!user?.userId && project.members.some((member) => member.userId === user.userId);
  const canEditRows = isAdmin || isLead || isMember;
  const canToggleVerified = isAdmin || isLead || !!user;

  return (
    <main className="min-h-screen bg-slate-50 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4">
        <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
          <div className="mb-2 text-sm text-slate-500 dark:text-slate-400">
            <Link href="/projects" className="text-cyan-700 hover:underline dark:text-cyan-300">Projects</Link>
            <span className="mx-2">/</span>
            <span>{project.projectId}</span>
          </div>
          <h1 className="text-2xl font-semibold">{project.title}</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{project.description || "No description"}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
              Lead: {project.lead.username || project.lead.displayName || project.lead.userId}
            </span>
            <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
              Members: {project.members.length}
            </span>
            <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
              Status: {project.status}
            </span>
            <span className="rounded bg-slate-100 px-2 py-1 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
              Updated: {fmt(project.updatedAt)}
            </span>
          </div>
        </header>

        <ProjectRowsTable
          projectId={projectId}
          rows={rowsResult.rows}
          canEditRows={canEditRows}
          canToggleVerified={canToggleVerified}
        />
      </div>
    </main>
  );
}
