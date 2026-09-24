import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FormField } from "../forms/FormField";
import { TextareaField } from "../forms/TextareaField";
import { SelectField } from "../forms/SelectField";
import { Button } from "../ui/Button";
import { PRIORITY_META, REQUIREMENT_STATUS_META } from "../../lib/statusMeta";
import { PRIORITIES, REQUIREMENT_STATUSES, type Requirement } from "../../types/requirement";
import {
  criteriaArrayToText,
  criteriaTextToArray,
  requirementFormSchema,
  type RequirementFormSchemaValues,
} from "../../validators/requirementSchemas";

const statusOptions = REQUIREMENT_STATUSES.map((value) => ({
  value,
  label: REQUIREMENT_STATUS_META[value].label,
}));
const priorityOptions = PRIORITIES.map((value) => ({ value, label: PRIORITY_META[value].label }));

interface RequirementFormProps {
  defaultValues?:
    Pick<Requirement, "title" | "description" | "status" | "priority" | "acceptanceCriteria"> | undefined;
  submitLabel: string;
  submittingLabel: string;
  serverError?: string | null | undefined;
  onSubmit: (values: {
    title: string;
    description?: string | undefined;
    status?: Requirement["status"] | undefined;
    priority?: Requirement["priority"] | undefined;
    acceptanceCriteria: string[];
  }) => Promise<void>;
  onCancel: () => void;
}

export function RequirementForm({
  defaultValues,
  submitLabel,
  submittingLabel,
  serverError,
  onSubmit,
  onCancel,
}: RequirementFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequirementFormSchemaValues>({
    resolver: zodResolver(requirementFormSchema),
    defaultValues: {
      title: defaultValues?.title ?? "",
      description: defaultValues?.description ?? "",
      status: defaultValues?.status ?? "draft",
      priority: defaultValues?.priority ?? "medium",
      acceptanceCriteriaText: criteriaArrayToText(defaultValues?.acceptanceCriteria ?? []),
    },
  });

  const handleFormSubmit = handleSubmit(async (values) => {
    await onSubmit({
      title: values.title,
      description: values.description,
      status: values.status,
      priority: values.priority,
      acceptanceCriteria: criteriaTextToArray(values.acceptanceCriteriaText),
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
      <TextareaField
        label="Acceptance criteria (one per line)"
        placeholder={"Users can reset their password via email\nA reset link expires after 1 hour"}
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
