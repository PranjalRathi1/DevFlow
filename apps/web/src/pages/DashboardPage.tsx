import { Link } from "react-router-dom";
import { FolderKanban, Plus } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useProjects } from "../queries/projectQueries";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { LoadingState } from "../components/ui/LoadingState";
import { ErrorState } from "../components/ui/ErrorState";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { PROJECT_STATUS_META } from "../lib/statusMeta";
import { errorMessage } from "../lib/errorMessage";

export default function DashboardPage() {
  const { user } = useAuth();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Welcome back, {user?.displayName}
        </h1>
        <p className="mt-1 text-sm text-slate-500">Here's what's happening across your projects.</p>
      </div>

      {isLoading && <LoadingState label="Loading dashboard…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {projects && (
        <>
          {/* Every number here comes directly from the fetched project list —
              no fabricated metrics. Task counts aren't shown yet: they'd need
              an aggregation across every project's tasks, which doesn't exist
              as a dedicated endpoint yet (see docs/DECISIONS.md). */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total Projects</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{projects.length}</p>
            </Card>
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Active</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                {projects.filter((p) => p.status === "active").length}
              </p>
            </Card>
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Completed</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">
                {projects.filter((p) => p.status === "completed").length}
              </p>
            </Card>
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Recently updated</h2>
              <Link to="/app/projects" className="text-sm font-medium text-brand-600 hover:underline">
                View all
              </Link>
            </div>

            {projects.length === 0 ? (
              <EmptyState
                icon={<FolderKanban className="h-8 w-8" />}
                title="No projects yet"
                description="Create your first project to start planning engineering work."
                action={
                  <Link to="/app/projects/new">
                    <Button size="sm">
                      <Plus className="h-4 w-4" /> New Project
                    </Button>
                  </Link>
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {[...projects]
                  .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                  .slice(0, 6)
                  .map((project) => {
                    const meta = PROJECT_STATUS_META[project.status];
                    return (
                      <Link key={project._id} to={`/app/projects/${project._id}`}>
                        <Card className="h-full transition-shadow hover:shadow-md">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium text-slate-900">{project.name}</p>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </div>
                          {project.description && (
                            <p className="mt-1 line-clamp-2 text-sm text-slate-500">{project.description}</p>
                          )}
                        </Card>
                      </Link>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
