import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useProject } from "../../queries/projectQueries";
import { LoadingState } from "../../components/ui/LoadingState";
import { ErrorState } from "../../components/ui/ErrorState";
import { Badge } from "../../components/ui/Badge";
import { PROJECT_STATUS_META } from "../../lib/statusMeta";
import { errorMessage } from "../../lib/errorMessage";
import { ApiError } from "../../services/apiClient";

const tabs = [
  { to: "overview", label: "Overview" },
  { to: "requirements", label: "Requirements" },
  { to: "tasks", label: "Tasks" },
  { to: "plans", label: "Plans" },
  { to: "scan", label: "Scan" },
  { to: "graph", label: "Graph" },
];

export function ProjectDetailLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { data: project, isLoading, isError, error } = useProject(projectId ?? "");

  if (isLoading) return <LoadingState label="Loading project…" />;

  if (isError) {
    // A 404 here means "doesn't exist or isn't yours" — the backend
    // deliberately doesn't distinguish (see docs/SECURITY.md). Send the
    // user back to their project list rather than showing a dead-end error.
    if (error instanceof ApiError && error.status === 404) {
      return (
        <ErrorState
          message="This project doesn't exist or you don't have access to it."
          onRetry={() => void navigate("/app/projects")}
        />
      );
    }
    return <ErrorState message={errorMessage(error)} />;
  }

  if (!project) return null;

  const meta = PROJECT_STATUS_META[project.status];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{project.name}</h1>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        {project.description && <p className="mt-1 text-sm text-slate-500">{project.description}</p>}
      </div>

      <div className="border-b border-slate-200">
        <nav className="-mb-px flex gap-4">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet context={project} />
    </div>
  );
}
