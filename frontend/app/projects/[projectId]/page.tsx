import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchProjectDetail, fetchProjectSources } from "../../lib/api";
import { fetchBackendSession } from "../../lib/server-session";
import ProjectSpreadsheetPanel from "./project-spreadsheet-panel";
import ProjectSourcesTable from "./project-sources-table";
import ProjectSummaryCard from "./project-summary-card";
import ProjectUploadSourceForm from "./project-upload-source-form";

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: { projectId: string };
  searchParams?: { limit?: string; offset?: string };
}) {
  const projectId = params.projectId;
  const limitRaw = Number(searchParams?.limit ?? "20");
  const offsetRaw = Number(searchParams?.offset ?? "0");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  const [project, sourcesResult, session] = await Promise.all([
    fetchProjectDetail(projectId).catch(() => notFound()),
    fetchProjectSources(projectId, { limit, offset }).catch(() => ({ sources: [], total: 0, limit, offset })),
    fetchBackendSession().catch(() => ({ user: null }))
  ]);

  const user = session.user;
  const roles = user?.roles || [];
  const isAdmin = roles.includes("admin");
  const isLead = !!user?.userId && user.userId === project.lead.userId;
  const isMember = !!user?.userId && project.members.some((member) => member.userId === user.userId);
  const canEditProject = isAdmin || isLead;
  const canUpload = isAdmin || isLead || isMember;
  const canRemoveSources = isLead;
  const canJoin = !!user?.userId && !isLead && !isMember;

  return (
    <main className="min-h-screen bg-slate-50 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          <Link href="/projects" className="text-cyan-700 hover:underline dark:text-cyan-300">Projects</Link>
          <span className="mx-2">/</span>
          <span>{project.projectId}</span>
        </div>

        <ProjectSummaryCard
          project={project}
          canEdit={canEditProject}
          canJoin={canJoin}
        />

        <ProjectSpreadsheetPanel project={project} />

        {canUpload && <ProjectUploadSourceForm projectId={projectId} />}

        <ProjectSourcesTable
          projectId={projectId}
          sources={sourcesResult.sources}
          total={sourcesResult.total}
          limit={sourcesResult.limit}
          offset={sourcesResult.offset}
          canRemoveSources={canRemoveSources}
        />
      </div>
    </main>
  );
}
