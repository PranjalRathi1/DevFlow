import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Pencil } from "lucide-react";
import { useProjectContext } from "./useProjectContext";
import { useDeleteProject, useUpdateProject } from "../../queries/projectQueries";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { ProjectForm } from "../../components/projects/ProjectForm";
import { errorMessage } from "../../lib/errorMessage";

export default function ProjectOverviewTab() {
  const project = useProjectContext();
  const navigate = useNavigate();
  const updateProject = useUpdateProject(project._id);
  const deleteProject = useDeleteProject();

  const [isEditing, setIsEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Project Details</h2>
          {!isEditing && (
            <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
        </div>

        {isEditing ? (
          <ProjectForm
            defaultValues={{ name: project.name, description: project.description, status: project.status }}
            submitLabel="Save Changes"
            submittingLabel="Saving…"
            serverError={editError}
            onCancel={() => {
              setIsEditing(false);
              setEditError(null);
            }}
            onSubmit={async (values) => {
              setEditError(null);
              try {
                await updateProject.mutateAsync(values);
                setIsEditing(false);
              } catch (err) {
                setEditError(errorMessage(err, "Failed to update project. Please try again."));
              }
            }}
          />
        ) : (
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Created</dt>
              <dd className="text-slate-900">{new Date(project.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Last updated</dt>
              <dd className="text-slate-900">{new Date(project.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        )}
      </Card>

      <Card className="border-dashed">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-slate-700">AI planning &amp; dependency graph</p>
            <p className="mt-1 text-sm text-slate-500">
              Coming in a future update: submit a requirement to the AI planner for a structured task
              breakdown, and visualize task dependencies as a graph. For now, requirements and tasks are
              created and managed manually below.
            </p>
          </div>
        </div>
      </Card>

      <Card className="border-danger-200">
        <h2 className="text-sm font-semibold text-danger-700">Danger Zone</h2>
        <p className="mt-1 text-sm text-slate-500">
          Deleting a project permanently removes it along with all of its requirements and tasks. This cannot
          be undone.
        </p>
        {deleteError && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {deleteError}
          </p>
        )}
        <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirmDeleteOpen(true)}>
          Delete Project
        </Button>
      </Card>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete "${project.name}"?`}
        description="This permanently deletes the project and all of its requirements and tasks. This cannot be undone."
        isConfirming={deleteProject.isPending}
        onConfirm={() => {
          setDeleteError(null);
          deleteProject.mutate(project._id, {
            onSuccess: () => {
              setConfirmDeleteOpen(false);
              void navigate("/app/projects");
            },
            onError: (err) => {
              setDeleteError(errorMessage(err, "Failed to delete project. Please try again."));
              setConfirmDeleteOpen(false);
            },
          });
        }}
      />
    </div>
  );
}
