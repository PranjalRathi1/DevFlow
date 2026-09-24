import { Link } from "react-router-dom";
import { FolderKanban, Plus } from "lucide-react";
import { useProjects } from "../queries/projectQueries";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { LoadingState } from "../components/ui/LoadingState";
import { ErrorState } from "../components/ui/ErrorState";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { PROJECT_STATUS_META } from "../lib/statusMeta";
import { errorMessage } from "../lib/errorMessage";

export default function ProjectsPage() {
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Projects</h1>
        <Link to="/app/projects/new">
          <Button size="sm">
            <Plus className="h-4 w-4" /> New Project
          </Button>
        </Link>
      </div>

      {isLoading && <LoadingState label="Loading projects…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {projects &&
        (projects.length === 0 ? (
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
            {projects.map((project) => {
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
                    <p className="mt-3 text-xs text-slate-400">
                      Updated {new Date(project.updatedAt).toLocaleDateString()}
                    </p>
                  </Card>
                </Link>
              );
            })}
          </div>
        ))}
    </div>
  );
}
