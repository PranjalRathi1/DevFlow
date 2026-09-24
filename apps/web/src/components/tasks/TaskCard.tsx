import { Pencil, Plus, Trash2 } from "lucide-react";
import { Card } from "../ui/Card";
import { PRIORITY_META, TASK_STATUS_META } from "../../lib/statusMeta";
import { PRIORITIES, TASK_STATUSES, type Priority, type Task, type TaskStatus } from "../../types/task";
import type { Requirement } from "../../types/requirement";
import { AffectedFileList } from "../plans/AffectedFileList";

interface TaskCardProps {
  task: Task;
  requirement?: Requirement | undefined;
  isSubtask?: boolean;
  onStatusChange: (status: TaskStatus) => void;
  onPriorityChange: (priority: Priority) => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddSubtask?: (() => void) | undefined;
}

export function TaskCard({
  task,
  requirement,
  isSubtask = false,
  onStatusChange,
  onPriorityChange,
  onEdit,
  onDelete,
  onAddSubtask,
}: TaskCardProps) {
  return (
    <Card className={isSubtask ? "border-slate-100 bg-slate-50/60" : ""}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-slate-900">{task.title}</p>
          {task.description && <p className="mt-1 text-sm text-slate-500">{task.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {requirement && (
              <span className="text-xs text-slate-400">
                Linked to <span className="text-slate-600">{requirement.title}</span>
              </span>
            )}
            {task.acceptanceCriteria.length > 0 && (
              <span className="text-xs text-slate-400">
                {task.acceptanceCriteria.length} acceptance{" "}
                {task.acceptanceCriteria.length === 1 ? "criterion" : "criteria"}
              </span>
            )}
          </div>
          {task.planEvidence && (
            <details className="mt-2 text-xs text-slate-600">
              <summary className="cursor-pointer text-slate-500">
                From an approved AI plan ·{" "}
                {task.planEvidence.sourceContext ? "grounded in a scan" : "not grounded in a scan"} ·{" "}
                {task.planEvidence.affectedFiles.length} file
                {task.planEvidence.affectedFiles.length === 1 ? "" : "s"}
              </summary>
              {task.planEvidence.sourceContext?.impactFile && (
                <p className="mt-1">
                  <span className="font-semibold">Planned change target:</span>{" "}
                  <code>{task.planEvidence.sourceContext.impactFile}</code>
                </p>
              )}
              {task.planEvidence.rationale && (
                <p className="mt-1">
                  <span className="font-semibold">AI rationale:</span> {task.planEvidence.rationale}
                </p>
              )}
              {task.planEvidence.testingApproach && (
                <p className="mt-1">
                  <span className="font-semibold">AI testing approach:</span>{" "}
                  {task.planEvidence.testingApproach}
                </p>
              )}
              <AffectedFileList
                files={task.planEvidence.affectedFiles}
                label={`Plan evidence files for ${task.title}`}
              />
            </details>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onAddSubtask && (
            <button
              type="button"
              aria-label={`Add subtask to ${task.title}`}
              onClick={onAddSubtask}
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Edit ${task.title}`}
            onClick={onEdit}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${task.title}`}
            onClick={onDelete}
            className="rounded-md p-1.5 text-slate-400 hover:bg-danger-50 hover:text-danger-600"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`status-${task._id}`}>
          Status for {task.title}
        </label>
        <select
          id={`status-${task._id}`}
          value={task.status}
          onChange={(e) => onStatusChange(e.target.value as TaskStatus)}
          className="rounded-full border-0 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 focus:ring-2 focus:ring-brand-500"
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {TASK_STATUS_META[status].label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`priority-${task._id}`}>
          Priority for {task.title}
        </label>
        <select
          id={`priority-${task._id}`}
          value={task.priority}
          onChange={(e) => onPriorityChange(e.target.value as Priority)}
          className="rounded-full border-0 bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 focus:ring-2 focus:ring-brand-500"
        >
          {PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_META[priority].label}
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}
