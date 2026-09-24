import { useState } from "react";
import { ClipboardList, Pencil, Plus, Trash2 } from "lucide-react";
import { useProjectContext } from "./useProjectContext";
import {
  useCreateRequirement,
  useDeleteRequirement,
  useRequirements,
  useUpdateRequirement,
} from "../../queries/requirementQueries";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Dialog } from "../../components/ui/Dialog";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { LoadingState } from "../../components/ui/LoadingState";
import { ErrorState } from "../../components/ui/ErrorState";
import { EmptyState } from "../../components/ui/EmptyState";
import { RequirementForm } from "../../components/requirements/RequirementForm";
import { PRIORITY_META, REQUIREMENT_STATUS_META } from "../../lib/statusMeta";
import { errorMessage } from "../../lib/errorMessage";
import type { Requirement } from "../../types/requirement";

export default function ProjectRequirementsTab() {
  const project = useProjectContext();
  const { data: requirements, isLoading, isError, error, refetch } = useRequirements(project._id);
  const createRequirement = useCreateRequirement(project._id);
  const updateRequirement = useUpdateRequirement(project._id);
  const deleteRequirement = useDeleteRequirement(project._id);

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Requirement | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Requirement | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Requirements</h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" /> New Requirement
        </Button>
      </div>

      {isLoading && <LoadingState label="Loading requirements…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {requirements &&
        (requirements.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-8 w-8" />}
            title="No requirements yet"
            description="Describe what needs to be built. You can break requirements into tasks manually, or (soon) let the AI planner suggest a breakdown."
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> New Requirement
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {requirements.map((requirement) => {
              const statusMeta = REQUIREMENT_STATUS_META[requirement.status];
              const priorityMeta = PRIORITY_META[requirement.priority];
              return (
                <Card key={requirement._id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{requirement.title}</p>
                      {requirement.description && (
                        <p className="mt-1 text-sm text-slate-500">{requirement.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                        <Badge tone={priorityMeta.tone}>{priorityMeta.label} priority</Badge>
                        {requirement.acceptanceCriteria.length > 0 && (
                          <span className="text-xs text-slate-400">
                            {requirement.acceptanceCriteria.length} acceptance{" "}
                            {requirement.acceptanceCriteria.length === 1 ? "criterion" : "criteria"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${requirement.title}`}
                        onClick={() => setEditing(requirement)}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${requirement.title}`}
                        onClick={() => setPendingDelete(requirement)}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-danger-50 hover:text-danger-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        ))}

      <Dialog open={createOpen} onOpenChange={setCreateOpen} title="New Requirement">
        <RequirementForm
          submitLabel="Create"
          submittingLabel="Creating…"
          serverError={createError}
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (values) => {
            setCreateError(null);
            try {
              await createRequirement.mutateAsync(values);
              setCreateOpen(false);
            } catch (err) {
              setCreateError(errorMessage(err, "Failed to create requirement. Please try again."));
            }
          }}
        />
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title="Edit Requirement"
      >
        {editing && (
          <RequirementForm
            defaultValues={editing}
            submitLabel="Save Changes"
            submittingLabel="Saving…"
            serverError={editError}
            onCancel={() => setEditing(null)}
            onSubmit={async (values) => {
              setEditError(null);
              try {
                await updateRequirement.mutateAsync({ id: editing._id, payload: values });
                setEditing(null);
              } catch (err) {
                setEditError(errorMessage(err, "Failed to update requirement. Please try again."));
              }
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.title}"?`}
        description="This permanently deletes the requirement. Tasks linked to it will keep their other details but lose this link. This cannot be undone."
        isConfirming={deleteRequirement.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          setDeleteError(null);
          deleteRequirement.mutate(pendingDelete._id, {
            onSuccess: () => setPendingDelete(null),
            onError: (err) => {
              setDeleteError(errorMessage(err, "Failed to delete requirement. Please try again."));
              setPendingDelete(null);
            },
          });
        }}
      />
      {deleteError && (
        <p role="alert" className="text-sm text-red-600">
          {deleteError}
        </p>
      )}
    </div>
  );
}
