import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FormField } from "../forms/FormField";
import { TextareaField } from "../forms/TextareaField";
import { SelectField } from "../forms/SelectField";
import { Button } from "../ui/Button";
import { PRIORITY_META, TASK_STATUS_META } from "../../lib/statusMeta";
import { PRIORITIES, TASK_STATUSES, type Task } from "../../types/task";
import type { Requirement } from "../../types/requirement";
import { criteriaArrayToText, criteriaTextToArray } from "../../validators/requirementSchemas";
import { taskFormSchema, type TaskFormSchemaValues } from "../../validators/taskSchemas";

const statusOptions = TASK_STATUSES.map((value) => ({ value, label: TASK_STATUS_META[value].label }));
const priorityOptions = PRIORITIES.map((value) => ({ value, label: PRIORITY_META[value].label }));

interface TaskFormProps {
  requirements: Requirement[];
  defaultValues?:
    | Pick<Task, "title" | "description" | "status" | "priority" | "acceptanceCriteria" | "requirement">
    | undefined;
  submitLabel: string;
  submittingLabel: string;
  serverError?: string | null | undefined;
  onSubmit: (values: {
    title: string;
    description?: string | undefined;
    status?: Task["status"] | undefined;
    priority?: Task["priority"] | undefined;
    acceptanceCriteria: string[];
    requirementId: string | null;
  }) => Promise<void>;
  onCancel: () => void;
}

export function TaskForm({
  requirements,
  defaultValues,
  submitLabel,
  submittingLabel,
  serverError,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<TaskFormSchemaValues>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: {
      title: defaultValues?.title ?? "",
      description: defaultValues?.description ?? "",
      status: defaultValues?.status ?? "todo",
      priority: defaultValues?.priority ?? "medium",
      acceptanceCriteriaText: criteriaArrayToText(defaultValues?.acceptanceCriteria ?? []),
      requirementId: defaultValues?.requirement ?? "",
    },
  });

  const requirementOptions = [
    { value: "", label: "None" },
    ...requirements.map((r) => ({ value: r._id, label: r.title })),
  ];

  const handleFormSubmit = handleSubmit(async (values) => {
    await onSubmit({
      title: values.title,
      description: values.description,
      status: values.status,
      priority: values.priority,
      acceptanceCriteria: criteriaTextToArray(values.acceptanceCriteriaText),
      requirementId: values.requirementId || null,
    });
  });

  return (
    <form onSubmit={handleFormSubmit} noValidate className="flex flex-col gap-4">
      <FormField label="Title" type="text" error={errors.title?.message} {...register("title")} />
      <TextareaField label="Description" error={errors.description?.message} {...register("description")} />
      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Status"
          options={statusOptions}
          error={errors.status?.message}
          {...register("status")}
        />
        <SelectField
          label="Priority"
          options={priorityOptions}
          error={errors.priority?.message}
          {...register("priority")}
        />
      </div>
      <SelectField
        label="Requirement"
        options={requirementOptions}
        error={errors.requirementId?.message}
        {...register("requirementId")}
      />
      <TextareaField
        label="Acceptance criteria (one per line)"
        error={errors.acceptanceCriteriaText?.message}
        {...register("acceptanceCriteriaText")}
      />

      {serverError && (
        <p role="alert" className="text-sm text-red-600">
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
