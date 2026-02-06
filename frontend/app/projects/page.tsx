import Link from "next/link";
import { fetchProjects } from "../lib/api";
import { fetchBackendSession } from "../lib/server-session";
import CreateProjectForm from "./create-project-form";

function formatDate(value?: string) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default async function ProjectsPage() {
  const [data, session] = await Promise.all([
    fetchProjects({ limit: 100, offset: 0, status: "active" }),
    fetchBackendSession().catch(() => ({ user: null }))
  ]);

  return (
    <main className="min-h-screen bg-slate-50 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4">
        <header className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Track score candidates, verification, and internal source creation.
          </p>
        </header>

        {session.user && <CreateProjectForm />}

        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/50">
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
            <thead className="bg-slate-100/80 text-left text-xs uppercase tracking-wide text-slate-600 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Project</th>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Members</th>
                <th className="px-3 py-2">Rows</th>
                <th className="px-3 py-2">Linked Sources</th>
                <th className="px-3 py-2">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.projects.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-slate-500 dark:text-slate-400" colSpan={6}>
                    No projects found.
                  </td>
                </tr>
              )}
              {data.projects.map((project) => (
                <tr key={project.projectId} className="hover:bg-slate-50 dark:hover:bg-slate-900/70">
                  <td className="px-3 py-3">
                    <Link
                      href={`/projects/${encodeURIComponent(project.projectId)}`}
                      className="font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
                    >
                      {project.title}
                    </Link>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{project.slug}</p>
                  </td>
                  <td className="px-3 py-3 text-slate-700 dark:text-slate-300">
                    {project.lead.username || project.lead.displayName || project.lead.userId}
                  </td>
                  <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{project.members.length}</td>
                  <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{project.rowCount}</td>
                  <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{project.linkedSourceCount}</td>
                  <td className="px-3 py-3 text-slate-700 dark:text-slate-300">{formatDate(project.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
