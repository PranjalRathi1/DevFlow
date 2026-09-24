import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "../components/ui/Card";
import { ProjectForm } from "../components/projects/ProjectForm";
import { useCreateProject } from "../queries/projectQueries";
import { errorMessage } from "../lib/errorMessage";

export default function NewProjectPage() {
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const [serverError, setServerError] = useState<string | null>(null);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">New Project</h1>
      <Card>
        <ProjectForm
          submitLabel="Create Project"
          submittingLabel="Creating…"
          serverError={serverError}
          onCancel={() => navigate("/app/projects")}
          onSubmit={async (values) => {
            setServerError(null);
            try {
              const project = await createProject.mutateAsync(values);
              void navigate(`/app/projects/${project._id}`);
            } catch (err) {
              setServerError(errorMessage(err, "Failed to create project. Please try again."));
            }
          }}
        />
      </Card>
    </div>
  );
}
