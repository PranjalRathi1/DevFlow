import { useMemo, useState } from "react";
import { ListTodo, Plus } from "lucide-react";
import { useProjectContext } from "./useProjectContext";
import { useCreateTask, useDeleteTask, useTasks, useUpdateTask } from "../../queries/taskQueries";
import { useRequirements } from "../../queries/requirementQueries";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { LoadingState } from "../../components/ui/LoadingState";
import { ErrorState } from "../../components/ui/ErrorState";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectField } from "../../components/forms/SelectField";
import { FormField } from "../../components/forms/FormField";
import { TaskCard } from "../../components/tasks/TaskCard";
import { TaskForm } from "../../components/tasks/TaskForm";
import { PRIORITY_META, TASK_STATUS_META } from "../../lib/statusMeta";
import { errorMessage } from "../../lib/errorMessage";
import { PRIORITIES, TASK_STATUSES, type Priority, type Task, type TaskStatus } from "../../types/task";

const statusFilterOptions = [
  { value: "", label: "All statuses" },
  ...TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_META[s].label })),
];
const priorityFilterOptions = [
  { value: "", label: "All priorities" },
  ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label })),
];

type DialogState =
  { mode: "create" } | { mode: "create-subtask"; parentTaskId: string } | { mode: "edit"; task: Task };

export default function ProjectTasksTab() {
  const project = useProjectContext();

  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "">("");
  const [requirementFilter, setRequirementFilter] = useState("");
  const [search, setSearch] = useState("");

  const filters = {
    ...(statusFilter && { status: statusFilter }),
    ...(priorityFilter && { priority: priorityFilter }),
    ...(requirementFilter && { requirementId: requirementFilter }),
    ...(search.trim() && { search: search.trim() }),
  };

  const { data: tasks, isLoading, isError, error, refetch } = useTasks(project._id, filters);
  const { data: requirements } = useRequirements(project._id);
  const createTask = useCreateTask(project._id);
  const updateTask = useUpdateTask(project._id);
  const deleteTask = useDeleteTask(project._id);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const requirementById = useMemo(() => new Map((requirements ?? []).map((r) => [r._id, r])), [requirements]);

  // Group the flat, already-filtered list into a tree. A subtask whose
  // parent didn't also match the current filters is rendered as its own
  // root row rather than silently dropped — filtering never hides a task
  // that was actually returned by the API.
  const { roots, childrenByParent } = useMemo(() => {
    const list = tasks ?? [];
    const ids = new Set(list.map((t) => t._id));
    const byParent = new Map<string, Task[]>();
    const topLevel: Task[] = [];
    for (const task of list) {
      if (task.parentTask && ids.has(task.parentTask)) {
        const siblings = byParent.get(task.parentTask) ?? [];
        siblings.push(task);
        byParent.set(task.parentTask, siblings);
      } else {
        topLevel.push(task);
      }
    }
    return { roots: topLevel, childrenByParent: byParent };
  }, [tasks]);

  function closeDialog() {
    setDialog(null);
    setFormError(null);
  }

  function renderCard(task: Task, isSubtask: boolean) {
    return (
      <TaskCard
        key={task._id}
        task={task}
        requirement={task.requirement ? requirementById.get(task.requirement) : undefined}
        isSubtask={isSubtask}
        onStatusChange={(status) => updateTask.mutate({ id: task._id, payload: { status } })}
        onPriorityChange={(priority) => updateTask.mutate({ id: task._id, payload: { priority } })}
        onEdit={() => setDialog({ mode: "edit", task })}
        onDelete={() => setPendingDelete(task)}
        onAddSubtask={
          isSubtask ? undefined : () => setDialog({ mode: "create-subtask", parentTaskId: task._id })
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Tasks</h2>
        <Button size="sm" onClick={() => setDialog({ mode: "create" })}>
          <Plus className="h-4 w-4" /> New Task
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SelectField
          label="Status"
          name="statusFilter"
          options={statusFilterOptions}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as TaskStatus | "")}
        />
        <SelectField
          label="Priority"
          name="priorityFilter"
          options={priorityFilterOptions}
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value as Priority | "")}
        />
        <SelectField
          label="Requirement"
          name="requirementFilter"
          options={[
            { value: "", label: "All requirements" },
            ...(requirements ?? []).map((r) => ({ value: r._id, label: r.title })),
          ]}
          value={requirementFilter}
          onChange={(e) => setRequirementFilter(e.target.value)}
        />
        <FormField
          label="Search"
          name="search"
          type="search"
          placeholder="Task title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading && <LoadingState label="Loading tasks…" />}
      {isError && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}

      {tasks &&
        (roots.length === 0 ? (
          <EmptyState
            icon={<ListTodo className="h-8 w-8" />}
            title={tasks.length === 0 ? "No tasks yet" : "No tasks match these filters"}
            description={
              tasks.length === 0
                ? "Break your requirements into concrete, trackable tasks."
                : "Try clearing a filter to see more tasks."
            }
            action={
              tasks.length === 0 ? (
                <Button size="sm" onClick={() => setDialog({ mode: "create" })}>
                  <Plus className="h-4 w-4" /> New Task
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {roots.map((task) => (
              <div key={task._id} className="flex flex-col gap-2">
                {renderCard(task, false)}
                {(childrenByParent.get(task._id) ?? []).length > 0 && (
                  <div className="ml-6 flex flex-col gap-2 border-l-2 border-slate-100 pl-4">
                    {(childrenByParent.get(task._id) ?? []).map((subtask) => renderCard(subtask, true))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && closeDialog()}
        title={
          dialog?.mode === "edit"
            ? "Edit Task"
            : dialog?.mode === "create-subtask"
              ? "New Subtask"
              : "New Task"
        }
      >
        {dialog && (
          <TaskForm
            requirements={requirements ?? []}
            defaultValues={dialog.mode === "edit" ? dialog.task : undefined}
            submitLabel={dialog.mode === "edit" ? "Save Changes" : "Create"}
            submittingLabel={dialog.mode === "edit" ? "Saving…" : "Creating…"}
            serverError={formError}
            onCancel={closeDialog}
            onSubmit={async (values) => {
              setFormError(null);
              try {
                if (dialog.mode === "edit") {
                  await updateTask.mutateAsync({ id: dialog.task._id, payload: values });
                } else {
                  await createTask.mutateAsync({
                    ...values,
                    parentTaskId: dialog.mode === "create-subtask" ? dialog.parentTaskId : null,
                  });
                }
                closeDialog();
              } catch (err) {
                setFormError(errorMessage(err, "Failed to save task. Please try again."));
              }
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.title}"?`}
        description="This permanently deletes the task and any of its subtasks. This cannot be undone."
        isConfirming={deleteTask.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          setDeleteError(null);
          deleteTask.mutate(pendingDelete._id, {
            onSuccess: () => setPendingDelete(null),
            onError: (err) => {
              setDeleteError(errorMessage(err, "Failed to delete task. Please try again."));
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
